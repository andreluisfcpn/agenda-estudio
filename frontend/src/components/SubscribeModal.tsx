// ─── Modal "Cobrança automática" (E9) ──────────────────────────────────────────
// Aberto pelo card do contrato ("Ativar cobrança automática" / "Cobrança automática ativa").
// Usa o mecanismo CORRETO: User.autoChargeEnabled + cartão padrão + autoChargeJob — nunca assinatura
// Stripe. A cobrança automática é por CLIENTE (vale para todas as parcelas, de todos os contratos).
//
//  • estado: stripeApi.getAutoCharge();
//  • ativar/trocar o cartão: contractsApi.subscribe(contractId, { paymentMethodId }) — só CRÉDITO;
//  • cartão novo, sem sair do modal: createSetupIntent → StripeCardForm (modo setup) →
//    confirmSetupIntent (grava o cartão na hora) → subscribe;
//  • desligar: stripeApi.setAutoCharge(false).
//
// Regras anti-submit espúrio (design-system §3b): sem <form> próprio (o do Stripe vive no StripeCardForm),
// todo botão type="button" com key distinta, troca de tela adiada 1 tick, ignoreMultiClick nos botões de
// ação e trava por requisição em voo — nunca por tempo.

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { AlertTriangle, Check, CheckCircle2, Plus, ShieldCheck, ShieldOff } from 'lucide-react';
import BottomSheetModal from './BottomSheetModal';
import StripeCardForm from './StripeCardForm';
import BrandLoader from './ui/BrandLoader';
import {
    ApiError, contractsApi, stripeApi,
    type AutoChargeCard, type ContractWithStats, type SavedCard,
} from '../api/client';
import { ignoreMultiClick } from '../hooks/useWizardStep';
import { getErrorMessage } from '../utils/errors';
import { formatBRL, formatDateFull } from '../utils/format';
import { getBrandIcon } from '../utils/cardBrand';
import { isPlanInstallment } from '../utils/paymentLabels';
import '../styles/auto-charge-modal.css';

interface AutoChargeModalProps {
    isOpen: boolean;
    /** Contrato de onde o cliente abriu o modal (null = fechado). */
    contract: ContractWithStats | null;
    onClose: () => void;
    /**
     * A cobrança automática mudou (ativou, trocou o cartão ou desligou). A página deve atualizar o estado
     * SEM desmontar a tela (nada de recarregar com esqueleto): o modal continua aberto mostrando o resultado.
     */
    onChanged?: () => void;
}

type View =
    | 'loading' | 'loadError'
    | 'active'      // já ligada: cartão em uso + trocar / desligar
    | 'choose'      // escolher um cartão de crédito salvo ou cadastrar um novo
    | 'newCard'     // formulário do Stripe (SetupIntent) dentro do modal
    | 'finishing'   // gravando o cartão novo e ativando
    | 'retry'       // cartão confirmado no Stripe, mas a gravação/ativação falhou — dá para tentar de novo
    | 'confirmOff' | 'off'
    | 'success'
    | 'blocked';    // este contrato não tem o que cobrar (quitado / cancelado)

type CardRef = Pick<AutoChargeCard, 'brand' | 'last4'>;

const BRAND_LABELS: Record<string, string> = {
    visa: 'Visa', mastercard: 'Mastercard', elo: 'Elo', amex: 'Amex', hipercard: 'Hipercard',
};
const brandName = (brand: string) => BRAND_LABELS[brand?.toLowerCase()] || 'Cartão';
const cardExp = (c: { expMonth: number; expYear: number }) =>
    `${String(c.expMonth).padStart(2, '0')}/${String(c.expYear).slice(-2)}`;

/** Só crédito entra na cobrança automática. `unknown` passa (o Stripe nem sempre classifica) — o backend confere. */
const isCreditCard = (c: SavedCard) => c.funding !== 'debit' && c.funding !== 'prepaid';

const codeOf = (err: unknown) => (err instanceof ApiError ? err.code : undefined);

export default function AutoChargeModal({ isOpen, contract, onClose, onChanged }: AutoChargeModalProps) {
    // Título e trava de fechamento vêm do corpo (que só existe enquanto o modal está aberto — cada abertura
    // começa do zero, sem estado vazando da anterior).
    const [chrome, setChrome] = useState<{ title: string; busy: boolean }>({ title: 'Cobrança automática', busy: false });
    // `preventClose` chega ao sheet um render depois do clique; esta trava é lida NA HORA de fechar (Esc, fundo,
    // X, arrastar) — enquanto há uma requisição em voo o modal não fecha, sem janela de corrida.
    const lockRef = useRef(false);
    const close = useCallback(() => {
        if (lockRef.current) return;
        onClose();
    }, [onClose]);

    return (
        <BottomSheetModal isOpen={isOpen && !!contract} onClose={close} title={chrome.title} preventClose={chrome.busy} size="sm">
            {isOpen && contract && (
                <AutoChargeBody key={contract.id} contract={contract} onClose={close} onChanged={onChanged} onChrome={setChrome} lockRef={lockRef} />
            )}
        </BottomSheetModal>
    );
}

interface AutoChargeBodyProps {
    contract: ContractWithStats;
    onClose: () => void;
    onChanged?: () => void;
    onChrome: (chrome: { title: string; busy: boolean }) => void;
    /** true enquanto há requisição em voo (o fechamento do modal consulta na hora). */
    lockRef: MutableRefObject<boolean>;
}

function AutoChargeBody({ contract, onClose, onChanged, onChrome, lockRef }: AutoChargeBodyProps) {
    const [view, setView] = useState<View>('loading');
    const [error, setError] = useState('');
    const [loadError, setLoadError] = useState('');
    const [blockedMsg, setBlockedMsg] = useState('');

    // Estado da cobrança automática (do cliente) e cartões salvos.
    const [enabled, setEnabled] = useState(false);
    const [activeCard, setActiveCard] = useState<AutoChargeCard | null>(null);
    const [cards, setCards] = useState<SavedCard[]>([]);
    const [cardsFailed, setCardsFailed] = useState(false);
    /** Cartões que o backend recusou por não serem de crédito (mesmo que a lista os mostre como "unknown"). */
    const [rejectedIds, setRejectedIds] = useState<string[]>([]);
    const [selected, setSelected] = useState<string | null>(null);

    // Cartão novo (SetupIntent)
    const [setupSecret, setSetupSecret] = useState<string | null>(null);
    const [pendingSetupId, setPendingSetupId] = useState<string | null>(null);
    const [stripeBusy, setStripeBusy] = useState(false);

    // Requisição em voo: trava de ENVIO (nunca por tempo).
    const [busy, setBusy] = useState<'setup' | 'activate' | 'off' | null>(null);
    const inFlightRef = useRef(false);

    const [result, setResult] = useState<{ card: CardRef; alreadyEnabled: boolean; switched: boolean } | null>(null);

    const aliveRef = useRef(true);
    const viewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        aliveRef.current = true;
        return () => {
            aliveRef.current = false;
            if (viewTimerRef.current) clearTimeout(viewTimerRef.current);
        };
    }, []);

    /**
     * Troca de tela a partir de um CLIQUE: adiada 1 tick, para o botão clicado não virar outro (na mesma
     * posição) enquanto o clique ainda está sendo processado.
     */
    const goView = useCallback((next: View) => {
        if (viewTimerRef.current) clearTimeout(viewTimerRef.current);
        viewTimerRef.current = setTimeout(() => {
            viewTimerRef.current = null;
            setError('');
            setView(next);
        }, 0);
    }, []);

    const creditCards = cards.filter(c => isCreditCard(c) && !rejectedIds.includes(c.id) && !rejectedIds.includes(c.stripePaymentMethodId));
    const otherCards = cards.length - creditCards.length;
    const selectedCard = creditCards.find(c => c.id === selected)
        ?? creditCards.find(c => c.isDefault)
        ?? creditCards[0]
        ?? null;

    // Cobranças deste contrato que o job cobraria: só PARCELAS DO PLANO pendentes (AC-1). A cobrança
    // automática nunca debita sozinha a multa de cancelamento nem a cobrança de uma gravação (extra /
    // reserva com `bookingId`) — essas partem sempre do cliente.
    const openCharges = (contract.payments || [])
        .filter(p => p.status === 'PENDING' && isPlanInstallment(p))
        .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
    const nextCharge = openCharges[0];

    const reloadCards = useCallback(async (): Promise<SavedCard[] | null> => {
        stripeApi.invalidateCache();
        try {
            const res = await stripeApi.listPaymentMethods();
            if (!aliveRef.current) return null;
            setCards(res.paymentMethods);
            setCardsFailed(false);
            return res.paymentMethods;
        } catch {
            if (aliveRef.current) setCardsFailed(true);
            return null;
        }
    }, []);

    const load = useCallback(async () => {
        setView('loading');
        setError('');
        setLoadError('');
        try {
            stripeApi.invalidateCache();
            const [state, pm] = await Promise.all([
                stripeApi.getAutoCharge(),
                // Sem a lista (Stripe fora do ar) ainda dá para ver o estado, desligar e cadastrar um cartão novo.
                stripeApi.listPaymentMethods().catch(() => null),
            ]);
            if (!aliveRef.current) return;
            setEnabled(state.autoChargeEnabled);
            setActiveCard(state.defaultCard);
            setCards(pm?.paymentMethods ?? []);
            setCardsFailed(!pm);
            setSelected(state.defaultCard?.id ?? null);
            setView(state.autoChargeEnabled && state.defaultCard ? 'active' : 'choose');
        } catch (err) {
            if (!aliveRef.current) return;
            setLoadError(getErrorMessage(err) || 'Não foi possível consultar a cobrança automática.');
            setView('loadError');
        }
    }, []);

    useEffect(() => { void load(); }, [load]);

    // Título e trava de fechamento do sheet.
    const isBusy = busy !== null || stripeBusy || view === 'finishing';
    const title = !enabled && (view === 'choose' || view === 'newCard' || view === 'finishing' || view === 'retry')
        ? 'Ativar cobrança automática'
        : 'Cobrança automática';
    lockRef.current = isBusy;
    useEffect(() => { onChrome({ title, busy: isBusy }); }, [onChrome, title, isBusy]);
    useEffect(() => () => {
        lockRef.current = false;
        onChrome({ title: 'Cobrança automática', busy: false });
    }, [onChrome, lockRef]);

    // ─── Ativar / trocar o cartão ───────────────────────────
    /** Chama o /subscribe. Pressupõe a trava em voo já tomada por quem chama. `newCard` = cartão recém-cadastrado. */
    const runActivate = async (cardId: string, newCard?: CardRef) => {
        const switched = enabled && !!activeCard;
        try {
            const res = await contractsApi.subscribe(contract.id, { paymentMethodId: cardId });
            if (!aliveRef.current) return;
            setEnabled(true);
            setActiveCard(res.defaultCard);
            setSelected(res.defaultCard.id);
            setResult({ card: res.defaultCard, alreadyEnabled: res.alreadyEnabled, switched });
            setError('');
            setView('success');
            onChanged?.();
        } catch (err) {
            if (!aliveRef.current) return;
            const code = codeOf(err);
            const saved = newCard ? `O cartão •••• ${newCard.last4} ficou salvo na sua carteira` : '';
            if (code === 'CARD_NOT_CREDIT') {
                setRejectedIds(prev => (prev.includes(cardId) ? prev : [...prev, cardId]));
                await reloadCards();
                if (!aliveRef.current) return;
                setError(newCard
                    ? `${saved}, mas é de débito ou pré-pago: a cobrança automática aceita só cartão de crédito. Escolha ou cadastre um cartão de crédito.`
                    : 'Este cartão é de débito ou pré-pago: a cobrança automática aceita só cartão de crédito. Escolha outro ou cadastre um cartão de crédito.');
                setView('choose');
            } else if (code === 'CARD_NOT_FOUND') {
                await reloadCards();
                if (!aliveRef.current) return;
                setError('Não encontramos este cartão — ele pode ter sido removido. Atualizamos a lista: escolha outro ou cadastre um novo.');
                setView('choose');
            } else if (code === 'NOTHING_TO_CHARGE' || code === 'CONTRACT_CANCELLED') {
                const why = code === 'NOTHING_TO_CHARGE'
                    ? 'Este contrato foi pago à vista e já está quitado: não há parcelas para cobrar automaticamente.'
                    : 'Este contrato foi cancelado: não há parcelas para cobrar automaticamente.';
                setBlockedMsg(newCard ? `${why} ${saved}.` : why);
                setView('blocked');
            } else {
                const msg = getErrorMessage(err) || 'Não foi possível ativar a cobrança automática.';
                setError(newCard ? `${saved}, mas a ativação falhou: ${msg} Selecione-o e toque em “Ativar cobrança automática”.` : msg);
                setView('choose');
            }
        }
    };

    const handleActivate = async () => {
        if (view !== 'choose' || !selectedCard) return;
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        setBusy('activate');
        setError('');
        try {
            await runActivate(selectedCard.id);
        } finally {
            inFlightRef.current = false;
            if (aliveRef.current) setBusy(null);
        }
    };

    // ─── Cartão novo (SetupIntent dentro do modal) ──────────
    const handleNewCard = async () => {
        if (view !== 'choose') return;
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        setBusy('setup');
        setError('');
        try {
            // Reaproveita o SetupIntent aberto (o cliente voltou e entrou de novo) — só um novo depois de usado.
            const secret = setupSecret ?? (await stripeApi.createSetupIntent()).clientSecret;
            if (!aliveRef.current) return;
            if (!secret) throw new Error('Não foi possível iniciar o cadastro do cartão. Tente novamente.');
            setSetupSecret(secret);
            setView('newCard');
        } catch (err) {
            if (!aliveRef.current) return;
            setError(getErrorMessage(err) || 'Não foi possível iniciar o cadastro do cartão. Tente novamente.');
        } finally {
            inFlightRef.current = false;
            if (aliveRef.current) setBusy(null);
        }
    };

    /** Cartão confirmado no Stripe → grava aqui (sem esperar o webhook) → ativa a cobrança automática nele. */
    const finishNewCard = async (setupIntentId: string) => {
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        setBusy('activate');
        setError('');
        setView('finishing');
        try {
            let card: SavedCard;
            try {
                card = (await stripeApi.confirmSetupIntent({ setupIntentId })).card;
            } catch (err) {
                if (!aliveRef.current) return;
                const code = codeOf(err);
                if (code === 'SETUP_INTENT_NOT_FOUND' || code === 'CARD_NOT_FOUND') {
                    setPendingSetupId(null);
                    await reloadCards();
                    if (!aliveRef.current) return;
                    setError('Não conseguimos localizar o cartão recém-cadastrado. Confira a lista ou cadastre-o de novo.');
                    setView('choose');
                } else {
                    // 409 (o banco ainda confirma), 502 ou queda de rede: o cartão JÁ está confirmado no Stripe.
                    setError(code === 'SETUP_INTENT_NOT_CONFIRMED'
                        ? 'O banco ainda está confirmando o cartão. Aguarde alguns segundos e tente de novo.'
                        : (getErrorMessage(err) || 'Não foi possível salvar o cartão agora.'));
                    setView('retry');
                }
                return;
            }
            if (!aliveRef.current) return;
            setPendingSetupId(null);
            setCards(prev => [card, ...prev.filter(c => c.id !== card.id && c.stripePaymentMethodId !== card.stripePaymentMethodId)]);
            setCardsFailed(false);
            setSelected(card.id);
            await runActivate(card.id, card);
        } finally {
            inFlightRef.current = false;
            if (aliveRef.current) setBusy(null);
        }
    };

    const handleSetupConfirmed = (setupIntentId?: string) => {
        setSetupSecret(null); // SetupIntent consumido: um próximo cartão novo abre outro
        if (!setupIntentId) {
            // Sem o id não há como gravar daqui: o cartão chega pela confirmação do Stripe (webhook).
            void reloadCards();
            setError('Cartão confirmado. Selecione-o na lista para ativar a cobrança automática (se ainda não aparecer, aguarde alguns segundos e reabra).');
            setView('choose');
            return;
        }
        setPendingSetupId(setupIntentId);
        void finishNewCard(setupIntentId);
    };

    // ─── Desligar ───────────────────────────────────────────
    const handleTurnOff = async () => {
        if (view !== 'confirmOff') return;
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        setBusy('off');
        setError('');
        try {
            await stripeApi.setAutoCharge(false);
            if (!aliveRef.current) return;
            setEnabled(false);
            setView('off');
            onChanged?.();
        } catch (err) {
            if (!aliveRef.current) return;
            setError(getErrorMessage(err) || 'Não foi possível desligar a cobrança automática.');
        } finally {
            inFlightRef.current = false;
            if (aliveRef.current) setBusy(null);
        }
    };

    // ─── Pedaços de tela ────────────────────────────────────
    const errorBox = error && (
        <div className="autocharge-modal__alert autocharge-modal__alert--danger" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>{error}</span>
        </div>
    );

    const contractLine = nextCharge && (
        <p className="autocharge-modal__hint">
            Em <strong>{contract.name}</strong>: {openCharges.length === 1 ? '1 parcela em aberto' : `${openCharges.length} parcelas em aberto`}
            {' — '}a próxima, de {formatBRL(nextCharge.amount)}, vence em {formatDateFull(nextCharge.dueDate)}.
        </p>
    );

    const spinner = <span className="spinner" aria-hidden="true" style={{ width: 16, height: 16 }} />;

    if (view === 'loading') {
        return (
            <BrandLoader size="section" label="Consultando a cobrança automática…" />
        );
    }

    if (view === 'loadError') {
        return (
            <>
                <div className="autocharge-modal__alert autocharge-modal__alert--danger" role="alert">
                    <AlertTriangle size={16} aria-hidden="true" />
                    <span>{loadError}</span>
                </div>
                <div className="autocharge-modal__actions">
                    <button key="close" type="button" className="btn btn-secondary" onClick={ignoreMultiClick(onClose)}>Fechar</button>
                    <button key="reload" type="button" className="btn btn-primary" onClick={ignoreMultiClick(load)}>Tentar novamente</button>
                </div>
            </>
        );
    }

    if (view === 'finishing') {
        return (
            <div className="autocharge-modal__center">
                <BrandLoader size="compact" label="Salvando o cartão e ativando…" />
                <p className="autocharge-modal__center-text">Não feche esta janela.</p>
            </div>
        );
    }

    if (view === 'retry') {
        return (
            <>
                <p className="autocharge-modal__intro">
                    O cartão foi confirmado, mas ainda não conseguimos salvá-lo aqui e ativar a cobrança automática.
                </p>
                {errorBox}
                <div className="autocharge-modal__actions">
                    <button key="close" type="button" className="btn btn-secondary" onClick={ignoreMultiClick(onClose)} disabled={isBusy}>Fechar</button>
                    <button key="retry" type="button" className="btn btn-primary" disabled={isBusy || !pendingSetupId}
                        onClick={ignoreMultiClick(() => { if (pendingSetupId) void finishNewCard(pendingSetupId); })}>
                        Tentar de novo
                    </button>
                </div>
            </>
        );
    }

    if (view === 'blocked') {
        return (
            <>
                <div className="autocharge-modal__alert autocharge-modal__alert--warning" role="alert">
                    <AlertTriangle size={16} aria-hidden="true" />
                    <span>{blockedMsg}</span>
                </div>
                <div className="autocharge-modal__actions">
                    <button key="close" type="button" className="btn btn-primary" onClick={ignoreMultiClick(onClose)}>Fechar</button>
                </div>
            </>
        );
    }

    if (view === 'success' && result) {
        const last4 = `•••• ${result.card.last4}`;
        return (
            <>
                <div className="autocharge-modal__center" role="status">
                    <span className="autocharge-modal__center-icon"><CheckCircle2 size={30} aria-hidden="true" /></span>
                    <p className="autocharge-modal__center-title">
                        {result.alreadyEnabled
                            ? `A cobrança automática já estava ativa no cartão ${last4} — vale para todas as suas parcelas.`
                            : result.switched
                                ? `Cobrança automática agora no cartão ${last4} — vale para todas as suas parcelas.`
                                : `Cobrança automática ativada no cartão ${last4} — vale para todas as suas parcelas.`}
                    </p>
                    <p className="autocharge-modal__center-text">
                        No dia do vencimento, cada parcela em aberto dos seus contratos é cobrada neste cartão de crédito
                        ({brandName(result.card.brand)}). Para trocar o cartão ou desligar, volte aqui ou use Pagamentos → Carteira.
                    </p>
                </div>
                <div className="autocharge-modal__actions">
                    <button key="done" type="button" className="btn btn-primary" onClick={ignoreMultiClick(onClose)}>Concluir</button>
                </div>
            </>
        );
    }

    if (view === 'off') {
        return (
            <>
                <div className="autocharge-modal__center" role="status">
                    <span className="autocharge-modal__center-icon autocharge-modal__center-icon--muted"><ShieldOff size={28} aria-hidden="true" /></span>
                    <p className="autocharge-modal__center-title">Cobrança automática desligada.</p>
                    <p className="autocharge-modal__center-text">
                        As próximas parcelas não serão cobradas no cartão: pague cada uma por PIX ou cartão até o vencimento,
                        em Pagamentos. Seus cartões continuam salvos.
                    </p>
                </div>
                <div className="autocharge-modal__actions">
                    <button key="again" type="button" className="btn btn-secondary" onClick={ignoreMultiClick(() => goView('choose'))}>Ativar de novo</button>
                    <button key="close" type="button" className="btn btn-primary" onClick={ignoreMultiClick(onClose)}>Fechar</button>
                </div>
            </>
        );
    }

    if (view === 'confirmOff') {
        return (
            <>
                <p className="autocharge-modal__intro">
                    <strong>Desligar a cobrança automática?</strong><br />
                    As parcelas deixam de ser cobradas no cartão: você passa a pagar cada uma por conta própria (PIX ou cartão),
                    até o vencimento. Vale para todos os seus contratos. Seus cartões continuam salvos.
                </p>
                {errorBox}
                <div className="autocharge-modal__actions">
                    <button key="back" type="button" className="btn btn-secondary" disabled={isBusy} onClick={ignoreMultiClick(() => goView('active'))}>Voltar</button>
                    <button key="turn-off" type="button" className="btn btn-warning-solid" disabled={isBusy} onClick={ignoreMultiClick(handleTurnOff)}>
                        {busy === 'off' ? <>{spinner} Desligando…</> : 'Desligar'}
                    </button>
                </div>
            </>
        );
    }

    if (view === 'active' && activeCard) {
        const inList = cards.find(c => c.id === activeCard.id || c.stripePaymentMethodId === activeCard.stripePaymentMethodId);
        const notCredit = !!inList && !isCreditCard(inList);
        return (
            <>
                <div className="autocharge-modal__status">
                    <span className="autocharge-modal__status-icon"><ShieldCheck size={22} aria-hidden="true" /></span>
                    <div>
                        <div className="autocharge-modal__status-title">Cobrança automática ativa</div>
                        <div className="autocharge-modal__status-card">
                            {brandName(activeCard.brand)} •••• {activeCard.last4} · validade {cardExp(activeCard)}
                        </div>
                    </div>
                </div>
                <p className="autocharge-modal__intro">
                    No dia do vencimento, cada parcela em aberto é cobrada neste cartão. <strong>Vale para todas as suas parcelas</strong>,
                    de todos os seus contratos.
                </p>
                {contractLine}
                {notCredit && (
                    <div className="autocharge-modal__alert autocharge-modal__alert--warning" role="alert">
                        <AlertTriangle size={16} aria-hidden="true" />
                        <span>Este cartão é de débito ou pré-pago e a cobrança pode ser recusada. Troque por um cartão de crédito.</span>
                    </div>
                )}
                {errorBox}
                <div className="autocharge-modal__actions">
                    <button key="close" type="button" className="btn btn-secondary" onClick={ignoreMultiClick(onClose)}>Fechar</button>
                    <button key="switch" type="button" className="btn btn-primary" onClick={ignoreMultiClick(() => goView('choose'))}>Trocar o cartão</button>
                </div>
                <div style={{ textAlign: 'center' }}>
                    <button key="off" type="button" className="autocharge-modal__link" onClick={ignoreMultiClick(() => goView('confirmOff'))}>
                        Desligar cobrança automática
                    </button>
                </div>
            </>
        );
    }

    if (view === 'newCard' && setupSecret) {
        return (
            <>
                <p className="autocharge-modal__intro">
                    Informe um <strong>cartão de crédito</strong>. Ele fica salvo na sua carteira, vira o seu cartão padrão e a
                    cobrança automática é ativada nele. Nenhuma cobrança é feita agora.
                </p>
                <StripeCardForm
                    mode="setup"
                    clientSecret={setupSecret}
                    submitLabel="Salvar cartão e ativar"
                    onSuccess={handleSetupConfirmed}
                    onError={() => { /* o próprio formulário mostra a falha do Stripe */ }}
                    onCancel={() => goView('choose')}
                    onProcessingChange={setStripeBusy}
                />
            </>
        );
    }

    // view === 'choose' (também o destino quando um estado acima perdeu o dado de que dependia)
    const switching = enabled && !!activeCard;
    return (
        <>
            <p className="autocharge-modal__intro">
                {switching
                    ? <>Escolha o <strong>cartão de crédito</strong> que passa a ser cobrado. Ele vira o seu cartão padrão.</>
                    : <>As parcelas em aberto passam a ser cobradas no seu <strong>cartão de crédito</strong>, no dia do vencimento. </>}
                {!switching && <><strong>Vale para todas as suas parcelas</strong>, de todos os seus contratos — não só deste.</>}
            </p>
            {contractLine}

            {enabled && !activeCard && (
                <div className="autocharge-modal__alert autocharge-modal__alert--warning" role="alert">
                    <AlertTriangle size={16} aria-hidden="true" />
                    <span>A cobrança automática está ligada, mas sem cartão salvo: nada é cobrado até você escolher um cartão.</span>
                </div>
            )}
            {cardsFailed && (
                <div className="autocharge-modal__alert autocharge-modal__alert--warning" role="alert">
                    <AlertTriangle size={16} aria-hidden="true" />
                    <span>Não foi possível carregar seus cartões salvos agora. Você pode cadastrar um cartão novo.</span>
                </div>
            )}

            <div className="autocharge-modal__cards">
                {creditCards.length > 0 && (
                    <>
                        <div className="checkout-section-label" id="autocharge-cards-label">Cartão de crédito</div>
                        <div className="checkout-saved-cards" role="radiogroup" aria-labelledby="autocharge-cards-label">
                            {creditCards.map(card => {
                                const isSel = selectedCard?.id === card.id;
                                return (
                                    <button
                                        key={card.id}
                                        type="button"
                                        role="radio"
                                        aria-checked={isSel}
                                        aria-label={`${brandName(card.brand)} final ${card.last4}, validade ${cardExp(card)}${card.isDefault ? ', cartão padrão' : ''}`}
                                        disabled={isBusy}
                                        onClick={() => setSelected(card.id)}
                                        className={`checkout-saved-card ${isSel ? 'checkout-saved-card--active' : ''}`}
                                    >
                                        <div className="checkout-saved-card-info">
                                            <span className="checkout-saved-card-brand">{getBrandIcon(card.brand)}</span>
                                            <span className="checkout-saved-card-number">•••• {card.last4}</span>
                                            <span className="checkout-saved-card-exp">{cardExp(card)}</span>
                                            {card.isDefault && <span className="autocharge-modal__tag">Padrão</span>}
                                        </div>
                                        <div className={`checkout-saved-card-radio ${isSel ? 'checkout-saved-card-radio--active' : ''}`}>
                                            {isSel && <Check size={12} aria-hidden="true" />}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                        <div className="checkout-saved-cards">
                            <button
                                key="new-card"
                                type="button"
                                disabled={isBusy}
                                onClick={ignoreMultiClick(handleNewCard)}
                                className="checkout-saved-card checkout-saved-card--new"
                            >
                                <div className="checkout-saved-card-info">
                                    <span className="checkout-saved-card-brand">
                                        {busy === 'setup' ? spinner : <Plus size={16} aria-hidden="true" />}
                                    </span>
                                    <span className="checkout-saved-card-number">Usar um cartão novo</span>
                                </div>
                            </button>
                        </div>
                    </>
                )}
            </div>

            {creditCards.length === 0 && !cardsFailed && (
                <p className="autocharge-modal__hint">
                    Você ainda não tem cartão de crédito salvo. Cadastre um aqui mesmo — ele fica guardado para os próximos pagamentos.
                </p>
            )}
            {otherCards > 0 && (
                <p className="autocharge-modal__hint">
                    {otherCards === 1 ? 'Seu cartão de débito ou pré-pago não aparece aqui' : 'Seus cartões de débito ou pré-pagos não aparecem aqui'}
                    : a cobrança automática aceita só cartão de crédito.
                </p>
            )}

            {errorBox}

            <div className="autocharge-modal__actions">
                {switching ? (
                    <button key="back" type="button" className="btn btn-secondary" disabled={isBusy} onClick={ignoreMultiClick(() => goView('active'))}>Voltar</button>
                ) : (
                    <button key="cancel" type="button" className="btn btn-secondary" disabled={isBusy} onClick={ignoreMultiClick(onClose)}>Cancelar</button>
                )}
                {creditCards.length > 0 ? (
                    <button key="activate" type="button" className="btn btn-primary" disabled={isBusy || !selectedCard} onClick={ignoreMultiClick(handleActivate)}>
                        {busy === 'activate'
                            ? <>{spinner} {switching ? 'Trocando…' : 'Ativando…'}</>
                            : switching ? 'Usar este cartão' : 'Ativar cobrança automática'}
                    </button>
                ) : (
                    <button key="new-card-primary" type="button" className="btn btn-primary" disabled={isBusy} onClick={ignoreMultiClick(handleNewCard)}>
                        {busy === 'setup' ? <>{spinner} Abrindo…</> : 'Cadastrar cartão de crédito'}
                    </button>
                )}
            </div>
        </>
    );
}
