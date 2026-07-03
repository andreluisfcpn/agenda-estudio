import { useState, useEffect } from 'react';
import { UserDetail } from '../../../api/client';

const ROLE_LABELS: Record<string, string> = { ADMIN: '🛡️ Administrador', CLIENTE: '👤 Cliente' };

/** Cabeçalho do perfil do cliente: foto (com fallback p/ iniciais), nome,
 *  contatos e badges de papel/status/tags. */
export default function ProfileHeader({ user }: { user: UserDetail }) {
    // Foto de upload pode ter sumido do disco (uploads efêmeros) — cai nas iniciais.
    const [photoError, setPhotoError] = useState(false);
    useEffect(() => { setPhotoError(false); }, [user.photoUrl]);

    return (
        <div className="card" style={{ padding: '24px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                {user.photoUrl && !photoError ? (
                    <img src={user.photoUrl} alt={user.name}
                        onError={() => setPhotoError(true)}
                        style={{
                            width: 64, height: 64, borderRadius: '50%', objectFit: 'cover',
                            border: '2px solid var(--accent-primary)',
                        }} />
                ) : (
                <div style={{
                    width: 64, height: 64, borderRadius: '50%',
                    background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '1.5rem', fontWeight: 700, color: '#fff',
                }}>
                    {user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
                </div>
                )}
                <div style={{ flex: 1 }}>
                    <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>{user.name}</h1>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginTop: '4px' }}>
                        {user.email} · {user.phone || 'Sem telefone'}
                        {user.cpfCnpj && <> · <span style={{ fontFamily: 'monospace' }}>{user.cpfCnpj}</span></>}
                    </div>
                    <div style={{ marginTop: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                        <span className={`badge ${user.role === 'ADMIN' ? 'badge-sabado' : 'badge-comercial'}`}>
                            {ROLE_LABELS[user.role]}
                        </span>
                        <span className="badge" style={{
                            background: user.clientStatus === 'ACTIVE' ? 'rgba(16,185,129,0.15)' : user.clientStatus === 'BLOCKED' ? 'rgba(220,38,38,0.15)' : 'rgba(107,114,128,0.15)',
                            color: user.clientStatus === 'ACTIVE' ? 'var(--success)' : user.clientStatus === 'BLOCKED' ? 'var(--danger)' : 'var(--neutral)',
                        }}>
                            {user.clientStatus === 'ACTIVE' ? '● Ativo' : user.clientStatus === 'BLOCKED' ? '● Bloqueado' : '● Inativo'}
                        </span>
                        {user.tags?.map((t: string) => (
                            <span key={t} style={{
                                fontSize: '0.6875rem', padding: '2px 8px', borderRadius: '999px',
                                background: 'rgba(17,129,155,0.15)', color: 'var(--accent-text)',
                            }}>#{t}</span>
                        ))}
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                            Cadastro: {new Date(user.createdAt).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
}
