import { usersApi, UserDetail } from '../../../api/client';
import FieldItem from './FieldItem';
import TagsEditor from './TagsEditor';
import SocialLinksEditor from './SocialLinksEditor';

interface ClientDataCardProps {
    user: UserDetail;
    /** Recarrega o perfil após salvar qualquer campo. */
    onSaved: () => void;
}

/** Card "Dados do Cliente": campos com edição inline, status, tags e redes. */
export default function ClientDataCard({ user, onSaved }: ClientDataCardProps) {
    return (
        <div className="card" style={{ padding: '20px', marginBottom: '16px' }}>
            <h2 style={{ fontSize: '1.0625rem', fontWeight: 700, marginBottom: '16px' }}>📇 Dados do Cliente</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px' }}>
                <FieldItem label="CPF/CNPJ" value={user.cpfCnpj} field="cpfCnpj" userId={user.id} onSaved={onSaved} />
                <FieldItem label="Endereço" value={user.address} field="address" userId={user.id} onSaved={onSaved} />
                <FieldItem label="Cidade" value={user.city} field="city" userId={user.id} onSaved={onSaved} />
                <FieldItem label="Estado" value={user.state} field="state" userId={user.id} onSaved={onSaved} />
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
                <TagsEditor tags={user.tags || []} userId={user.id} onSaved={onSaved} />
                <SocialLinksEditor socialLinks={user.socialLinks} userId={user.id} onSaved={onSaved} />
            </div>
        </div>
    );
}
