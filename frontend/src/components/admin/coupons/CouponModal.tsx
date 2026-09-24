import { getErrorMessage } from '../../../utils/errors';
import React, { useState, useEffect, useId, useRef } from 'react';
import { couponsApi, usersApi, ApiError, Coupon, CouponInput, CouponUserRef, UserSummary } from '../../../api/client';
import { useUI } from '../../../context/UIContext';
import BottomSheetModal from '../../BottomSheetModal';
import WizardSteps from '../WizardSteps';
import CurrencyInput from '../../ui/fields/CurrencyInput';
import { useWizardStep, ignoreMultiClick, wizardStepBodyStyle, wizardStepContentStyle } from '../../../hooks/useWizardStep';
import { formatBRL } from '../../../utils/format';
import { TicketPercent, NotebookPen, CircleDollarSign, Percent, Coins, RefreshCw, Users, Target, Sparkles, Search, X, Save, type LucideIcon } from 'lucide-react';

type Eligibility = 'ALL' | 'SPECIFIC' | 'NEW';

interface CouponModalProps {
    /** Cupom em edição; omitir/null = criação */
    coupon?: Coupon | null;
    onClose: () => void;
    onSaved: () => void;
}

const STEPS = ['Cupom', 'Regras', 'Elegibilidade'];

/** Etapa onde cada campo vive — leva o admin ao campo com erro (validação local ou API). */
const FIELD_STEP: Record<string, number> = {
    code: 1, description: 1, discountType: 1, discountValue: 1,
    scope: 2, expiresAt: 2, maxUses: 2, maxUsesPerUser: 2, minAmount: 2, active: 2,
    eligibility: 3,
};

/** Chaves de erro do backend (zod `path`) que aparecem num campo com outro nome na tela. */
const API_FIELD_ALIAS: Record<string, string> = { eligibleUserIds: 'eligibility', onlyNewClients: 'eligibility' };

type Tone = 'accent' | 'warning' | 'success';
const TONES: Record<Tone, { color: string; bg: string }> = {
    accent: { color: 'var(--accent-text)', bg: 'rgba(17, 129, 155, 0.12)' },
    warning: { color: 'var(--warning)', bg: 'var(--warning-bg)' },
    success: { color: 'var(--success)', bg: 'var(--success-bg)' },
};

/** Botão de escolha (tipo/escopo/elegibilidade) — selecionado no tom da seção. */
function choiceStyle(on: boolean, tone: Tone): React.CSSProperties {
    return {
        padding: '12px 14px', minHeight: 44, borderRadius: '10px', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
        display: 'flex', alignItems: 'center', gap: '10px', width: '100%',
        background: on ? TONES[tone].bg : 'var(--bg-elevated)',
        border: `1.5px solid ${on ? TONES[tone].color : 'var(--border-default)'}`,
        transition: 'background-color 0.15s, border-color 0.15s',
    };
}

function RadioDot({ on, tone }: { on: boolean; tone: Tone }) {
    return (
        <span aria-hidden="true" style={{
            width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
            border: `2px solid ${on ? TONES[tone].color : 'var(--border-default)'}`,
            background: on ? TONES[tone].color : 'transparent',
            boxShadow: on ? 'inset 0 0 0 2.5px var(--bg-elevated)' : 'none',
        }} />
    );
}

function ChoiceText({ icon: Icon, label, hint, on, tone }: { icon: LucideIcon; label: string; hint: string; on: boolean; tone: Tone }) {
    return (
        <span style={{ minWidth: 0 }}>
            <span style={{ fontSize: '0.8125rem', fontWeight: 700, color: on ? TONES[tone].color : 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Icon size={15} aria-hidden="true" /> {label}
            </span>
            <span style={{ fontSize: '0.625rem', color: 'var(--text-secondary)', display: 'block', marginTop: '2px' }}>{hint}</span>
        </span>
    );
}

const hintStyle: React.CSSProperties = { fontSize: '0.6875rem', color: 'var(--text-muted)', lineHeight: 1.4 };

/**
 * "Novo cupom" / "Editar cupom" — wizard de 3 etapas (D11): Cupom → Regras → Elegibilidade.
 * Valores em R$ com CurrencyInput (D10, centavos; `allowEmpty` = campo opcional).
 * Anti-submit espúrio: sem <form>, botões type="button" com keys distintas, avanço adiado
 * 1 tick (setTimeout 0), guard de etapa no salvar, botões do rodapé ignoram o 2º clique de um
 * clique duplo (ignoreMultiClick) e nenhuma trava por tempo. Altura mínima estável por etapa
 * (rodapé no mesmo lugar). Na edição o stepper permite pular etapas (allowJump) e o salvar valida TODAS.
 */
export default function CouponModal({ coupon, onClose, onSaved }: CouponModalProps) {
    const uid = useId();
    const { showToast } = useUI();
    const isEdit = !!coupon;
    const { step, back, goTo, isLast } = useWizardStep(STEPS.length);

    // ─── Form state ───
    const [code, setCode] = useState(coupon?.code || '');
    const [description, setDescription] = useState(coupon?.description || '');
    const [discountType, setDiscountType] = useState<'VALOR' | 'PERCENTUAL'>(coupon?.discountType || 'VALOR');
    // VALOR em centavos (null = vazio); PERCENTUAL como texto do campo numérico (1–100).
    const [valueCents, setValueCents] = useState<number | null>(coupon?.discountType === 'VALOR' ? coupon.discountValue : null);
    const [percentText, setPercentText] = useState(coupon?.discountType === 'PERCENTUAL' ? String(coupon.discountValue) : '');
    const [scope, setScope] = useState<'FIRST_PAYMENT' | 'ALL_INSTALLMENTS'>(coupon?.scope || 'FIRST_PAYMENT');
    const [expiresAt, setExpiresAt] = useState(coupon?.expiresAt ? coupon.expiresAt.slice(0, 10) : '');
    const [maxUses, setMaxUses] = useState(coupon?.maxUses != null ? String(coupon.maxUses) : '');
    const [maxUsesPerUser, setMaxUsesPerUser] = useState(coupon?.maxUsesPerUser != null ? String(coupon.maxUsesPerUser) : '');
    const [minAmountCents, setMinAmountCents] = useState<number | null>(coupon?.minAmount ?? null);
    const [active, setActive] = useState(coupon?.active ?? true);
    const [eligibility, setEligibility] = useState<Eligibility>(
        coupon?.onlyNewClients ? 'NEW' : (coupon?.eligibleUsers?.length ? 'SPECIFIC' : 'ALL')
    );
    const [selectedUsers, setSelectedUsers] = useState<CouponUserRef[]>(coupon?.eligibleUsers || []);

    // ─── Client picker (lazy: só carrega quando "clientes específicos" é escolhido) ───
    const [clients, setClients] = useState<UserSummary[]>([]);
    const [clientsState, setClientsState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
    const [clientSearch, setClientSearch] = useState('');
    useEffect(() => {
        if (eligibility !== 'SPECIFIC' || clientsState !== 'idle') return;
        setClientsState('loading');
        usersApi.getAll('CLIENTE')
            .then(r => { setClients(r.users); setClientsState('ok'); })
            .catch(() => setClientsState('error'));
    }, [eligibility, clientsState]);

    const [saving, setSaving] = useState(false);
    const [apiError, setApiError] = useState('');
    // Campos a que o banner se refere: some sozinho quando todos forem corrigidos.
    const [errorFields, setErrorFields] = useState<string[]>([]);
    // Erros do salvar/API (somem ao editar o campo) + campos já tocados (validação ao vivo).
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [touched, setTouched] = useState<Set<string>>(() => new Set());
    // Trava de requisição EM ANDAMENTO (não é trava por tempo): evita 2 POSTs num duplo clique.
    const inFlightRef = useRef(false);

    // Troca de etapa: sheet rola para o topo e o foco vai para o contêiner da etapa.
    const stepRef = useRef<HTMLDivElement>(null);
    const mountedRef = useRef(false);
    useEffect(() => {
        if (!mountedRef.current) { mountedRef.current = true; return; }
        const el = stepRef.current;
        if (!el) return;
        const body = el.closest('.bottom-sheet-body');
        if (body) body.scrollTop = 0;
        el.focus({ preventScroll: true });
    }, [step]);

    const touch = (f: string) => setTouched(t => (t.has(f) ? t : new Set(t).add(f)));
    const clearErr = (f: string) => setFieldErrors(fe => {
        if (!(f in fe)) return fe;
        const n = { ...fe };
        delete n[f];
        return n;
    });

    // ─── Validação por etapa ───
    const validateStep = (n: number): Record<string, string> => {
        const errs: Record<string, string> = {};
        if (n === 1) {
            if (!isEdit && code.trim().length < 3) errs.code = 'O código precisa de pelo menos 3 caracteres.';
            if (discountType === 'VALOR') {
                if (!valueCents || valueCents <= 0) errs.discountValue = 'Informe um desconto maior que zero.';
            } else {
                const t = percentText.trim();
                const pct = Number(t);
                if (!t) errs.discountValue = 'Informe o percentual de desconto (1 a 100).';
                else if (!Number.isInteger(pct) || pct < 1) errs.discountValue = 'Use um número inteiro de 1 a 100.';
                else if (pct > 100) errs.discountValue = 'O percentual não pode passar de 100%.';
            }
        } else if (n === 2) {
            const checkLimit = (key: 'maxUses' | 'maxUsesPerUser', raw: string) => {
                const t = raw.trim();
                if (!t) return;
                if (!/^\d+$/.test(t) || Number(t) < 1) errs[key] = 'Use um número inteiro a partir de 1 (ou deixe vazio).';
            };
            checkLimit('maxUses', maxUses);
            checkLimit('maxUsesPerUser', maxUsesPerUser);
            if (!errs.maxUses && isEdit && maxUses.trim() && Number(maxUses) < coupon!.usedCount) {
                errs.maxUses = `Este cupom já tem ${coupon!.usedCount} uso(s) — o limite não pode ser menor que isso.`;
            }
            if (minAmountCents !== null && minAmountCents <= 0) errs.minAmount = 'Informe um valor maior que zero (ou deixe vazio para não exigir mínimo).';
        } else if (n === 3) {
            if (eligibility === 'SPECIFIC' && selectedUsers.length === 0) errs.eligibility = 'Selecione pelo menos um cliente.';
        }
        return errs;
    };

    const isStepValid = (n: number) => Object.keys(validateStep(n)).length === 0;
    const liveErrors = { ...validateStep(1), ...validateStep(2), ...validateStep(3) };
    /** Erro visível do campo: o do salvar/API, ou o ao vivo se o campo já foi tocado. */
    const errOf = (f: string): string | undefined => fieldErrors[f] ?? (touched.has(f) ? liveErrors[f] : undefined);

    // Avanço adiado 1 tick (anti-submit espúrio) e com destino fixo: um clique duplo no
    // "Próximo" enfileira dois avanços para a MESMA etapa, sem pular a seguinte.
    const goNext = () => {
        if (!isStepValid(step)) return;
        const target = step + 1;
        setTimeout(() => goTo(target), 0);
    };

    const handleSave = async () => {
        if (!isLast || inFlightRef.current) return; // rede de segurança: só salva na última etapa
        setApiError('');
        // allowJump (edição) permite chegar aqui sem passar pelas etapas: valida todas.
        let firstInvalid = 0;
        const all: Record<string, string> = {};
        for (let s = 1; s <= STEPS.length; s++) {
            const e = validateStep(s);
            if (Object.keys(e).length) { if (!firstInvalid) firstInvalid = s; Object.assign(all, e); }
        }
        if (firstInvalid) {
            setFieldErrors(all);
            setErrorFields(Object.keys(all));
            setTouched(t => { const n = new Set(t); Object.keys(all).forEach(k => n.add(k)); return n; });
            setApiError('Revise os campos destacados antes de salvar.');
            goTo(firstInvalid);
            return;
        }
        inFlightRef.current = true;
        setSaving(true);
        try {
            const base: Omit<CouponInput, 'code'> = {
                description: description.trim() ? description.trim() : null,
                discountType,
                discountValue: discountType === 'VALOR' ? (valueCents ?? 0) : parseInt(percentText, 10),
                scope,
                expiresAt: expiresAt || null,               // 'YYYY-MM-DD' puro — nunca new Date local
                maxUses: maxUses.trim() ? parseInt(maxUses, 10) : null,
                maxUsesPerUser: maxUsesPerUser.trim() ? parseInt(maxUsesPerUser, 10) : null,
                minAmount: minAmountCents,                   // null = sem mínimo
                onlyNewClients: eligibility === 'NEW',
                eligibleUserIds: eligibility === 'SPECIFIC' ? selectedUsers.map(u => u.id) : [],
                active,
            };
            if (isEdit) {
                await couponsApi.update(coupon!.id, base);
                showToast('Cupom atualizado.');
            } else {
                await couponsApi.create({ code: code.trim(), ...base });
                showToast('Cupom criado!');
            }
            onSaved();
            onClose();
        } catch (err: unknown) {
            if (err instanceof ApiError || (err instanceof Error && err.name === 'ApiError')) {
                const apiErr = err as ApiError;
                const mapped: Record<string, string> = {};
                if (Array.isArray(apiErr.details) && apiErr.details.length > 0) {
                    (apiErr.details as { path?: (string | number)[]; message?: string }[]).forEach(issue => {
                        const key = (issue.path || []).join('.');
                        if (key) mapped[API_FIELD_ALIAS[key] || key] = issue.message || 'Valor inválido.';
                    });
                } else if (apiErr.status === 409 && !isEdit) {
                    mapped.code = apiErr.message;               // "Já existe um cupom com este código."
                } else if (/limite/i.test(apiErr.message)) {
                    mapped.maxUses = apiErr.message;            // limite menor que os usos já feitos
                } else if (/percentual/i.test(apiErr.message)) {
                    mapped.discountValue = apiErr.message;
                } else if (/espec[ií]ficos|novos clientes/i.test(apiErr.message)) {
                    mapped.eligibility = apiErr.message;
                }
                setFieldErrors(mapped);
                setErrorFields(Object.keys(mapped));
                setApiError(apiErr.message);
                const steps = Object.keys(mapped).map(k => FIELD_STEP[k]).filter((s): s is number => !!s);
                if (steps.length) goTo(Math.min(...steps));
            } else {
                setErrorFields([]);
                setApiError(getErrorMessage(err));
            }
        } finally {
            inFlightRef.current = false;
            setSaving(false);
        }
    };

    const toggleUser = (u: UserSummary) => {
        setSelectedUsers(prev => prev.some(s => s.id === u.id)
            ? prev.filter(s => s.id !== u.id)
            : [...prev, { id: u.id, name: u.name, email: u.email }]);
        touch('eligibility');
        clearErr('eligibility');
    };

    const filteredClients = clients.filter(u => {
        const q = clientSearch.trim().toLowerCase();
        if (!q) return true;
        return u.name.toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q);
    });

    const stepValid = isStepValid(step);
    const showApiError = !!apiError && (errorFields.length === 0 || errorFields.some(f => f in fieldErrors));
    const codeErr = errOf('code');
    const valueErr = errOf('discountValue');
    const maxUsesErr = errOf('maxUses');
    const maxUsesPerUserErr = errOf('maxUsesPerUser');
    const minAmountErr = errOf('minAmount');
    const eligibilityErr = errOf('eligibility');
    const expiresErr = errOf('expiresAt');

    // Resumo curto (etapa 3) — o que vai ser gravado, já que as etapas anteriores não estão à vista.
    const summaryValue = discountType === 'VALOR'
        ? (valueCents ? `${formatBRL(valueCents)} de desconto` : null)
        : (percentText.trim() ? `${percentText.trim()}% de desconto` : null);
    const summaryParts = [
        isEdit ? coupon!.code : (code.trim() || null),
        summaryValue,
        scope === 'FIRST_PAYMENT' ? 'só na 1ª cobrança' : 'em todas as parcelas',
        expiresAt ? `até ${expiresAt.split('-').reverse().join('/')}` : 'sem validade',
        maxUses.trim() ? `máx. ${maxUses.trim()} usos` : null,
        minAmountCents ? `cobranças a partir de ${formatBRL(minAmountCents)}` : null,
        active ? null : 'inativo',
    ].filter(Boolean);

    return (
        <BottomSheetModal isOpen onClose={onClose} hideHeader size="lg" className="admin-sheet" title={isEdit ? 'Editar Cupom' : 'Novo Cupom'}>
            <div className="admin-modal-head">
                <h2 className="admin-modal-title">
                    <span className="admin-modal-title__icon"><TicketPercent size={18} aria-hidden="true" /></span>
                    {isEdit ? 'Editar Cupom' : 'Novo Cupom'}
                </h2>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '6px 0 0' }}>
                    {isEdit ? `Ajuste as regras do cupom ${coupon!.code}` : 'Crie um cupom de desconto para pagamentos'}
                </p>
                <WizardSteps steps={STEPS} current={step} onStepClick={goTo} allowJump={isEdit} />
            </div>

            <div className="admin-modal-body">
                {showApiError && <div className="admin-alert admin-alert--danger" role="alert">{apiError}</div>}

                <div ref={stepRef} tabIndex={-1} role="group" aria-label={`Etapa ${step} de ${STEPS.length}: ${STEPS[step - 1]}`} style={{ outline: 'none', ...wizardStepBodyStyle }}>
                    {/* -------- ETAPA 1: Cupom (identificação + desconto) -------- */}
                    {step === 1 && (
                        <>
                        <div style={{ ...wizardStepContentStyle, display: 'grid', gap: '20px', alignContent: 'start' }}>
                            <div>
                                <div className="admin-section-header">Identificação</div>
                                <div className="admin-grid-2" style={{ gap: '12px' }}>
                                    <div className="admin-field">
                                        <label className="admin-field__label" htmlFor={`${uid}-codigo`}>Código{isEdit ? '' : ' *'}</label>
                                        <div className="admin-input-icon">
                                            <TicketPercent size={14} aria-hidden="true" />
                                            <input
                                                id={`${uid}-codigo`}
                                                value={code}
                                                onChange={e => { setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '')); clearErr('code'); }}
                                                onBlur={() => touch('code')}
                                                placeholder="Ex: BEMVINDO10"
                                                maxLength={32}
                                                disabled={isEdit}
                                                autoFocus={!isEdit}
                                                autoComplete="off"
                                                aria-required={!isEdit || undefined}
                                                aria-invalid={!!codeErr}
                                                aria-describedby={`${uid}-codigo-hint${codeErr ? ` ${uid}-codigo-err` : ''}`}
                                                className={`form-input form-input--raised${codeErr ? ' error' : ''}`}
                                                style={{ fontFamily: 'monospace', fontWeight: 700, letterSpacing: '0.08em', opacity: isEdit ? 0.6 : 1, cursor: isEdit ? 'not-allowed' : 'text' }}
                                            />
                                        </div>
                                        <div id={`${uid}-codigo-hint`} style={hintStyle}>
                                            {isEdit ? 'O código não pode ser alterado.' : '3 a 32 caracteres: letras, números, hífen e underline.'}
                                        </div>
                                        {codeErr && <div id={`${uid}-codigo-err`} className="field-error-message">{codeErr}</div>}
                                    </div>
                                    <div className="admin-field">
                                        <label className="admin-field__label" htmlFor={`${uid}-descricao`}>Descrição</label>
                                        <div className="admin-input-icon">
                                            <NotebookPen size={14} aria-hidden="true" />
                                            <input
                                                id={`${uid}-descricao`}
                                                value={description}
                                                onChange={e => { setDescription(e.target.value); clearErr('description'); }}
                                                placeholder="Ex: Boas-vindas de novos clientes"
                                                maxLength={500}
                                                autoComplete="off"
                                                className="form-input form-input--raised"
                                            />
                                        </div>
                                        {fieldErrors.description && <div className="field-error-message">{fieldErrors.description}</div>}
                                    </div>
                                </div>
                            </div>

                            <div>
                                <div className="admin-section-header" id={`${uid}-tipo-label`}>Desconto</div>
                                <div className="admin-grid-2" role="group" aria-labelledby={`${uid}-tipo-label`} style={{ gap: '8px', marginBottom: '14px' }}>
                                    {[
                                        { key: 'VALOR' as const, icon: CircleDollarSign, label: 'Valor fixo (R$)', desc: 'Desconta um valor exato em reais' },
                                        { key: 'PERCENTUAL' as const, icon: Percent, label: 'Percentual (%)', desc: 'Desconta uma porcentagem do total' },
                                    ].map(t => {
                                        const on = discountType === t.key;
                                        return (
                                            <button key={t.key} type="button" aria-pressed={on}
                                                onClick={() => { setDiscountType(t.key); clearErr('discountValue'); }}
                                                style={choiceStyle(on, 'accent')}>
                                                <ChoiceText icon={t.icon} label={t.label} hint={t.desc} on={on} tone="accent" />
                                            </button>
                                        );
                                    })}
                                </div>

                                <div className="admin-field">
                                    <label className="admin-field__label" htmlFor={`${uid}-discount-value`}>
                                        {discountType === 'VALOR' ? 'Valor do desconto *' : 'Percentual de desconto *'}
                                    </label>
                                    {discountType === 'VALOR' ? (
                                        <CurrencyInput
                                            id={`${uid}-discount-value`}
                                            allowEmpty
                                            value={valueCents}
                                            onChange={c => { setValueCents(c); clearErr('discountValue'); }}
                                            onBlur={() => touch('discountValue')}
                                            className={`form-input--raised${valueErr ? ' error' : ''}`}
                                            aria-required
                                            aria-invalid={!!valueErr}
                                            aria-describedby={valueErr ? `${uid}-discount-err` : undefined}
                                        />
                                    ) : (
                                        <div className="admin-input-icon">
                                            <Percent size={14} aria-hidden="true" />
                                            <input
                                                id={`${uid}-discount-value`}
                                                type="number" min={1} max={100} step={1}
                                                inputMode="numeric"
                                                value={percentText}
                                                onChange={e => { setPercentText(e.target.value); clearErr('discountValue'); touch('discountValue'); }}
                                                placeholder="Ex: 10"
                                                aria-required
                                                aria-invalid={!!valueErr}
                                                aria-describedby={valueErr ? `${uid}-discount-err` : undefined}
                                                className={`form-input form-input--raised${valueErr ? ' error' : ''}`}
                                            />
                                        </div>
                                    )}
                                    {discountType === 'VALOR' && <div style={hintStyle}>Os dígitos entram da direita: 5-0-0-0 = R$ 50,00.</div>}
                                    {valueErr && <div id={`${uid}-discount-err`} className="field-error-message">{valueErr}</div>}
                                </div>
                            </div>
                        </div>

                        <div className="admin-actions-row">
                            <button key="cancel" type="button" className="btn-admin-ghost" onClick={ignoreMultiClick(onClose)}>
                                Cancelar
                            </button>
                            <button key="next" type="button" className="btn-admin-go" disabled={!stepValid} onClick={ignoreMultiClick(goNext)}>
                                Próximo →
                            </button>
                        </div>
                        </>
                    )}

                    {/* -------- ETAPA 2: Regras (aplicação + limites) -------- */}
                    {step === 2 && (
                        <>
                        <div style={{ ...wizardStepContentStyle, display: 'grid', gap: '20px', alignContent: 'start' }}>
                            <div>
                                <div className="admin-section-header" id={`${uid}-scope-label`}>Aplicação</div>
                                <div role="group" aria-labelledby={`${uid}-scope-label`} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                    {[
                                        { key: 'FIRST_PAYMENT' as const, icon: Coins, label: 'Só a 1ª cobrança', hint: 'O desconto vale para a primeira fatura do contrato' },
                                        { key: 'ALL_INSTALLMENTS' as const, icon: RefreshCw, label: 'Todas as parcelas', hint: 'O desconto se repete em todas as mensalidades' },
                                    ].map(s => {
                                        const on = scope === s.key;
                                        return (
                                            <button key={s.key} type="button" aria-pressed={on} onClick={() => { setScope(s.key); clearErr('scope'); }} style={choiceStyle(on, 'warning')}>
                                                <RadioDot on={on} tone="warning" />
                                                <ChoiceText icon={s.icon} label={s.label} hint={s.hint} on={on} tone="warning" />
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            <div>
                                <div className="admin-section-header">Limites</div>
                                <div className="admin-grid-2" style={{ gap: '12px', marginBottom: '12px' }}>
                                    <div className="admin-field">
                                        <label className="admin-field__label" htmlFor={`${uid}-expires-at`}>Expira em</label>
                                        <input
                                            id={`${uid}-expires-at`}
                                            type="date"
                                            value={expiresAt}
                                            onChange={e => { setExpiresAt(e.target.value); clearErr('expiresAt'); }}
                                            aria-invalid={!!expiresErr}
                                            className={`form-input form-input--raised${expiresErr ? ' error' : ''}`}
                                        />
                                        <div style={hintStyle}>Deixe vazio para não expirar</div>
                                        {expiresErr && <div className="field-error-message">{expiresErr}</div>}
                                    </div>
                                    <div className="admin-field">
                                        <label className="admin-field__label" htmlFor={`${uid}-max-uses`}>Máx. de usos</label>
                                        <input
                                            id={`${uid}-max-uses`}
                                            type="number" min={isEdit ? Math.max(1, coupon!.usedCount) : 1} step={1}
                                            inputMode="numeric"
                                            value={maxUses}
                                            onChange={e => { setMaxUses(e.target.value); clearErr('maxUses'); touch('maxUses'); }}
                                            placeholder="Ex: 20"
                                            aria-invalid={!!maxUsesErr}
                                            aria-describedby={maxUsesErr ? `${uid}-max-uses-err` : undefined}
                                            className={`form-input form-input--raised${maxUsesErr ? ' error' : ''}`}
                                        />
                                        <div style={hintStyle}>
                                            Deixe vazio para ilimitado{isEdit && coupon!.usedCount > 0 ? ` · já usado ${coupon!.usedCount}×` : ''}
                                        </div>
                                        {maxUsesErr && <div id={`${uid}-max-uses-err`} className="field-error-message">{maxUsesErr}</div>}
                                    </div>
                                </div>

                                <div className="admin-grid-2" style={{ gap: '12px', marginBottom: '12px' }}>
                                    <div className="admin-field">
                                        <label className="admin-field__label" htmlFor={`${uid}-max-uses-per-user`}>Limite por cliente</label>
                                        <input
                                            id={`${uid}-max-uses-per-user`}
                                            type="number" min={1} step={1}
                                            inputMode="numeric"
                                            value={maxUsesPerUser}
                                            onChange={e => { setMaxUsesPerUser(e.target.value); clearErr('maxUsesPerUser'); touch('maxUsesPerUser'); }}
                                            placeholder="Ex: 1"
                                            aria-invalid={!!maxUsesPerUserErr}
                                            aria-describedby={maxUsesPerUserErr ? `${uid}-max-uses-per-user-err` : undefined}
                                            className={`form-input form-input--raised${maxUsesPerUserErr ? ' error' : ''}`}
                                        />
                                        <div style={hintStyle}>Quantas vezes o MESMO cliente pode usar (vazio = ilimitado)</div>
                                        {maxUsesPerUserErr && <div id={`${uid}-max-uses-per-user-err`} className="field-error-message">{maxUsesPerUserErr}</div>}
                                    </div>
                                    <div className="admin-field">
                                        <label className="admin-field__label" htmlFor={`${uid}-min-amount`}>Valor mínimo</label>
                                        <CurrencyInput
                                            id={`${uid}-min-amount`}
                                            allowEmpty
                                            value={minAmountCents}
                                            onChange={c => { setMinAmountCents(c); clearErr('minAmount'); touch('minAmount'); }}
                                            className={`form-input--raised${minAmountErr ? ' error' : ''}`}
                                            aria-invalid={!!minAmountErr}
                                            aria-describedby={minAmountErr ? `${uid}-min-amount-err` : undefined}
                                        />
                                        <div style={hintStyle}>Só vale em cobranças a partir deste valor (vazio = sem mínimo)</div>
                                        {minAmountErr && <div id={`${uid}-min-amount-err`} className="field-error-message">{minAmountErr}</div>}
                                    </div>
                                </div>

                                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', padding: '10px 14px', minHeight: 44, borderRadius: '10px', background: active ? 'var(--success-bg)' : 'var(--bg-elevated)', border: `1px solid ${active ? 'var(--success)' : 'var(--border-default)'}`, transition: 'background-color 0.15s, border-color 0.15s' }}>
                                    <input
                                        type="checkbox"
                                        checked={active}
                                        onChange={e => setActive(e.target.checked)}
                                        style={{ width: 16, height: 16, accentColor: 'var(--success)', cursor: 'pointer' }}
                                    />
                                    <span>
                                        <span style={{ fontSize: '0.8125rem', fontWeight: 700, color: active ? 'var(--success)' : 'var(--text-primary)' }}>Cupom ativo</span>
                                        <span style={{ fontSize: '0.625rem', color: 'var(--text-secondary)', display: 'block', marginTop: '2px' }}>Cupons inativos não podem ser aplicados em novos pagamentos</span>
                                    </span>
                                </label>
                            </div>
                        </div>

                        <div className="admin-actions-row admin-actions-row--between">
                            <button key="back" type="button" className="btn-admin-ghost" onClick={back}>
                                ← Voltar
                            </button>
                            <button key="next" type="button" className="btn-admin-go" disabled={!stepValid} onClick={ignoreMultiClick(goNext)}>
                                Próximo →
                            </button>
                        </div>
                        </>
                    )}

                    {/* -------- ETAPA 3: Elegibilidade -------- */}
                    {step === 3 && (
                        <>
                        <div style={wizardStepContentStyle}>
                            <div className="admin-section-header" id={`${uid}-elig-label`}>Quem pode usar</div>
                            <div role="group" aria-labelledby={`${uid}-elig-label`} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                {[
                                    { key: 'ALL' as const, icon: Users, label: 'Todos os clientes', hint: 'Qualquer cliente pode usar este cupom' },
                                    { key: 'SPECIFIC' as const, icon: Target, label: 'Apenas clientes específicos', hint: 'Escolha quem pode usar o cupom' },
                                    { key: 'NEW' as const, icon: Sparkles, label: 'Apenas clientes novos', hint: 'Clientes que nunca fizeram nenhum pagamento.' },
                                ].map(o => {
                                    const on = eligibility === o.key;
                                    return (
                                        <button key={o.key} type="button" aria-pressed={on} onClick={() => { setEligibility(o.key); clearErr('eligibility'); }} style={choiceStyle(on, 'success')}>
                                            <RadioDot on={on} tone="success" />
                                            <ChoiceText icon={o.icon} label={o.label} hint={o.hint} on={on} tone="success" />
                                        </button>
                                    );
                                })}
                            </div>

                            {eligibility === 'SPECIFIC' && (
                                <div style={{ marginTop: '12px', padding: '14px', borderRadius: '10px', background: 'var(--bg-secondary)', border: '1px solid var(--border-default)' }}>
                                    {/* Chips dos selecionados */}
                                    {selectedUsers.length > 0 && (
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
                                            {selectedUsers.map(u => (
                                                <span key={u.id} style={{
                                                    display: 'inline-flex', alignItems: 'center', gap: '6px',
                                                    padding: '4px 4px 4px 10px', borderRadius: '999px', fontSize: '0.6875rem', fontWeight: 600,
                                                    background: 'var(--success-bg)', border: '1px solid var(--success)', color: 'var(--success)',
                                                }}>
                                                    {u.name}
                                                    <button
                                                        type="button"
                                                        onClick={() => { setSelectedUsers(prev => prev.filter(s => s.id !== u.id)); touch('eligibility'); }}
                                                        aria-label={`Remover ${u.name}`}
                                                        style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 4, display: 'inline-flex', alignItems: 'center', borderRadius: '50%' }}>
                                                        <X size={12} aria-hidden="true" />
                                                    </button>
                                                </span>
                                            ))}
                                        </div>
                                    )}

                                    {/* Busca */}
                                    <div className="admin-input-icon" style={{ marginBottom: '8px' }}>
                                        <Search size={14} aria-hidden="true" />
                                        <input
                                            value={clientSearch}
                                            onChange={e => setClientSearch(e.target.value)}
                                            placeholder="Buscar por nome ou e-mail..."
                                            aria-label="Buscar cliente por nome ou e-mail"
                                            autoComplete="off"
                                            className="form-input form-input--raised"
                                        />
                                    </div>

                                    {/* Lista de clientes */}
                                    <div style={{ maxHeight: '220px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                        {clientsState === 'error' ? (
                                            <div role="alert" style={{ padding: '16px', textAlign: 'center', fontSize: '0.75rem', color: 'var(--danger)' }}>
                                                Não foi possível carregar os clientes.{' '}
                                                <button type="button" onClick={() => setClientsState('idle')} style={{ background: 'none', border: 'none', color: 'var(--accent-text)', textDecoration: 'underline', cursor: 'pointer', fontSize: 'inherit', fontFamily: 'inherit', padding: 0 }}>
                                                    Tentar de novo
                                                </button>
                                            </div>
                                        ) : filteredClients.length === 0 ? (
                                            <div style={{ padding: '16px', textAlign: 'center', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                                {clientsState !== 'ok' ? 'Carregando clientes...' : 'Nenhum cliente encontrado'}
                                            </div>
                                        ) : filteredClients.map(u => {
                                            const checked = selectedUsers.some(s => s.id === u.id);
                                            return (
                                                <label key={u.id} style={{
                                                    display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', minHeight: 44,
                                                    borderRadius: '8px', cursor: 'pointer',
                                                    background: checked ? 'var(--success-bg)' : 'transparent',
                                                    border: `1px solid ${checked ? 'rgba(16, 185, 129, 0.3)' : 'transparent'}`,
                                                    transition: 'background-color 0.15s, border-color 0.15s',
                                                }}>
                                                    <input
                                                        type="checkbox"
                                                        checked={checked}
                                                        onChange={() => toggleUser(u)}
                                                        style={{ width: 14, height: 14, accentColor: 'var(--success)', cursor: 'pointer', flexShrink: 0 }}
                                                    />
                                                    <span className="admin-avatar admin-avatar--sm" aria-hidden="true">{u.name.charAt(0).toUpperCase()}</span>
                                                    <span style={{ minWidth: 0 }}>
                                                        <span style={{ fontSize: '0.75rem', fontWeight: 600, display: 'block', color: 'var(--text-primary)' }}>{u.name}</span>
                                                        <span style={{ fontSize: '0.625rem', color: 'var(--text-muted)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</span>
                                                    </span>
                                                </label>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                            {eligibilityErr
                                ? <div className="field-error-message" role="alert">{eligibilityErr}</div>
                                : (eligibility === 'SPECIFIC' && selectedUsers.length === 0 && <div style={{ ...hintStyle, marginTop: '6px' }}>Selecione pelo menos um cliente para salvar.</div>)}

                            {summaryParts.length > 0 && (
                                <div style={{ ...hintStyle, marginTop: '16px', padding: '10px 12px', borderRadius: '10px', border: '1px dashed var(--border-default)' }}>
                                    <strong style={{ color: 'var(--text-secondary)' }}>Resumo:</strong> {summaryParts.join(' · ')}
                                </div>
                            )}
                        </div>

                        <div className="admin-actions-row admin-actions-row--between">
                            <button key="back" type="button" className="btn-admin-ghost" onClick={back} disabled={saving}>
                                ← Voltar
                            </button>
                            {/* ignoreMultiClick: o 2º clique de um duplo clique no "Próximo" da etapa 2 cai aqui
                                (mesma posição) e NÃO pode criar/salvar sem o admin ver a Elegibilidade. */}
                            <button key="submit" type="button" className="btn-admin-go" disabled={!stepValid || saving} aria-busy={saving || undefined} onClick={ignoreMultiClick(handleSave)}>
                                {saving ? 'Salvando…' : isEdit ? <><Save size={16} aria-hidden="true" /> Salvar alterações</> : <><TicketPercent size={16} aria-hidden="true" /> Criar cupom</>}
                            </button>
                        </div>
                        </>
                    )}
                </div>
            </div>
        </BottomSheetModal>
    );
}
