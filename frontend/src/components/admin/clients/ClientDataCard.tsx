import { Ban, IdCard } from 'lucide-react';
import { usersApi, UserDetail } from '../../../api/client';
import { useUI } from '../../../context/UIContext';
import { getErrorMessage } from '../../../utils/errors';
import FieldItem from './FieldItem';
import TagsEditor from './TagsEditor';
import SocialLinksEditor from './SocialLinksEditor';
import AddressEditor from './AddressEditor';
import CommitSelect from '../CommitSelect';

interface ClientDataCardProps {
    user: UserDetail;
    /** Recarrega o perfil após salvar qualquer campo. */
    onSaved: () => void;
}

const sectionDivider = { paddingTop: '16px', marginTop: '16px', borderTop: '1px solid var(--border-color)' } as const;

/** Card "Dados do Cliente": identificação, endereço estruturado, status, tags e redes. */
export default function ClientDataCard({ user, onSaved }: ClientDataCardProps) {
    const { showConfirm, showToast } = useUI();

    const saveStatus = async (clientStatus: string) => {
        await usersApi.update(user.id, { clientStatus });
        onSaved();
    };

    const handleStatusChange = (next: string) => {
        if (next === user.clientStatus) return;
        // D3: bloquear barra o login — confirmação de perigo antes de gravar. O select é controlado
        // (value = status atual), então ele volta sozinho enquanto o admin não confirmar.
        if (next === 'BLOCKED') {
            showConfirm({
                tone: 'danger',
                // Tem volta (status → Ativo): vermelho da D3, mas sem o selo "Irreversível".
                irreversible: false,
                icon: Ban,
                title: `Bloquear ${user.name}?`,
                message: 'O cliente não conseguirá entrar no app.',
                consequences: [
                    'O login por senha, por código no e-mail e pelo Google passa a ser recusado ("Sua conta está bloqueada").',
                    'Uma sessão já aberta é encerrada na hora.',
                    'Contratos, gravações e cobranças (inclusive a cobrança automática) continuam como estão.',
                    'Para liberar o acesso de novo, volte o status para Ativo.',
                ],
                confirmLabel: 'Bloquear cliente',
                loadingLabel: 'Bloqueando…',
                // Sem try/catch: o erro da API aparece dentro do diálogo.
                onConfirm: async () => {
                    await saveStatus('BLOCKED');
                    showToast('Cliente bloqueado.');
                },
            });
            return;
        }
        saveStatus(next).catch((err: unknown) => {
            showToast({ message: getErrorMessage(err) || 'Não foi possível alterar o status.', type: 'error' });
        });
    };

    return (
        <div className="card" style={{ padding: '20px', marginBottom: '16px' }}>
            <h2 style={{ fontSize: '1.0625rem', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: 8 }}><IdCard size={17} aria-hidden="true" /> Dados do Cliente</h2>

            {/* Identificação — CPF/CNPJ + Status lado a lado (empilham no mobile) */}
            <div className="admin-grid-2" style={{ gap: '12px' }}>
                <FieldItem label="CPF/CNPJ" value={user.cpfCnpj} field="cpfCnpj" userId={user.id} onSaved={onSaved} />
                <div>
                    <label htmlFor={`client-status-${user.id}`} style={{ display: 'block', fontSize: '0.6875rem', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '4px' }}>Status</label>
                    {/* CommitSelect: setas no select fechado não gravam a cada passo (Enter/sair do campo aplica). */}
                    <CommitSelect id={`client-status-${user.id}`} className="form-select" value={user.clientStatus}
                        onCommit={handleStatusChange}
                        style={{ fontSize: '0.8125rem', padding: '6px 8px' }}>
                        <option value="ACTIVE">● Ativo</option>
                        <option value="INACTIVE">● Inativo</option>
                        <option value="BLOCKED">● Bloqueado</option>
                    </CommitSelect>
                </div>
            </div>

            {/* Endereço estruturado (bloco próprio → nada aperta no canto) */}
            <div style={sectionDivider}>
                <AddressEditor user={user} onSaved={onSaved} />
            </div>

            {/* Tags + Redes sociais — blocos empilhados (flex, não grid: evita span-2 forçar colunas) */}
            <div style={{ ...sectionDivider, display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <TagsEditor tags={user.tags || []} userId={user.id} onSaved={onSaved} />
                <SocialLinksEditor socialLinks={user.socialLinks} userId={user.id} onSaved={onSaved} />
            </div>
        </div>
    );
}
