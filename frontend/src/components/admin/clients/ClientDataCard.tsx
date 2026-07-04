import { usersApi, UserDetail } from '../../../api/client';
import FieldItem from './FieldItem';
import TagsEditor from './TagsEditor';
import SocialLinksEditor from './SocialLinksEditor';
import AddressEditor from './AddressEditor';
import { IdCard } from 'lucide-react';

interface ClientDataCardProps {
    user: UserDetail;
    /** Recarrega o perfil após salvar qualquer campo. */
    onSaved: () => void;
}

const sectionDivider = { paddingTop: '16px', marginTop: '16px', borderTop: '1px solid var(--border-color)' } as const;

/** Card "Dados do Cliente": identificação, endereço estruturado, status, tags e redes. */
export default function ClientDataCard({ user, onSaved }: ClientDataCardProps) {
    return (
        <div className="card" style={{ padding: '20px', marginBottom: '16px' }}>
            <h2 style={{ fontSize: '1.0625rem', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: 8 }}><IdCard size={17} aria-hidden="true" /> Dados do Cliente</h2>

            {/* Identificação — CPF/CNPJ + Status lado a lado (empilham no mobile) */}
            <div className="admin-grid-2" style={{ gap: '12px' }}>
                <FieldItem label="CPF/CNPJ" value={user.cpfCnpj} field="cpfCnpj" userId={user.id} onSaved={onSaved} />
                <div>
                    <div style={{ fontSize: '0.6875rem', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '4px' }}>Status</div>
                    <select className="form-select" value={user.clientStatus} onChange={async (e) => {
                        try { await usersApi.update(user.id, { clientStatus: e.target.value } as any); onSaved(); } catch {}
                    }} style={{ fontSize: '0.8125rem', padding: '6px 8px' }}>
                        <option value="ACTIVE">● Ativo</option>
                        <option value="INACTIVE">● Inativo</option>
                        <option value="BLOCKED">● Bloqueado</option>
                    </select>
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
