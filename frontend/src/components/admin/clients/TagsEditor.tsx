import { useState } from 'react';
import { usersApi } from '../../../api/client';
import { useUI } from '../../../context/UIContext';
import { X } from 'lucide-react';

const SAVE_ERROR = { message: 'Não foi possível salvar. Tente novamente.', type: 'error' as const };

interface TagsEditorProps {
    tags: string[];
    userId: string;
    onSaved: () => void;
}

/** Editor de tags do cliente (adicionar no Enter/blur, remover no X). */
export default function TagsEditor({ tags, userId, onSaved }: TagsEditorProps) {
    const { showToast } = useUI();
    const [newTag, setNewTag] = useState('');
    const addTag = async () => {
        const t = newTag.trim().toLowerCase();
        if (!t || tags.includes(t)) { setNewTag(''); return; }
        try { await usersApi.update(userId, { tags: [...tags, t] } as any); setNewTag(''); onSaved(); } catch { showToast(SAVE_ERROR); }
    };
    const removeTag = async (tag: string) => {
        try { await usersApi.update(userId, { tags: tags.filter(t => t !== tag) } as any); onSaved(); } catch { showToast(SAVE_ERROR); }
    };
    return (
        <div>
            <div style={{ fontSize: '0.6875rem', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '4px' }}>Tags</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
                {tags.map(t => (
                    <span key={t} style={{ fontSize: '0.6875rem', padding: '2px 8px', borderRadius: '999px', background: 'rgba(17,129,155,0.15)', color: 'var(--accent-text)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        #{t}
                        <button onClick={() => removeTag(t)} aria-label={`Remover tag ${t}`}
                            style={{ cursor: 'pointer', opacity: 0.6, background: 'none', border: 'none', color: 'inherit', padding: '2px 4px', display: 'inline-flex', alignItems: 'center' }}><X size={12} aria-hidden="true" /></button>
                    </span>
                ))}
                <input placeholder="+ tag" aria-label="Adicionar tag" value={newTag} onChange={e => setNewTag(e.target.value)} onKeyDown={e => e.key === 'Enter' && addTag()} onBlur={addTag}
                    style={{ width: '70px', background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: '0.75rem', minHeight: 32 }} />
            </div>
        </div>
    );
}
