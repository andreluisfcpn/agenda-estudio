import { useState, useEffect, type ReactNode, type CSSProperties } from 'react';

/** Iniciais: primeira letra de até 2 palavras do nome (fallback "??"). */
function computeInitials(name?: string | null): string {
    return (name || '')
        .split(' ')
        .map(w => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase() || '??';
}

interface AvatarProps {
    photoUrl?: string | null;
    name?: string | null;
    /** Classe do container (ex.: "topbar-avatar") que provê tamanho, forma e o gradiente das iniciais. */
    className?: string;
    title?: string;
    onClick?: () => void;
    /** Overlays extras dentro do avatar (ex.: spinner de upload). */
    children?: ReactNode;
    style?: CSSProperties;
}

/**
 * Avatar consistente em todo o app:
 *  - INICIAIS sobre o gradiente (fornecido pela classe do container) preenchem 100% do círculo
 *    quando NÃO há foto OU quando a foto falha ao carregar;
 *  - a FOTO cobre 100% do círculo (background-size: cover, indo até a borda) quando é válida.
 *
 * A foto é aplicada como background-image (cobre o border-box inteiro — a borda não "come" a
 * imagem como aconteceria com um <img> posicionado). A validade é checada com um pré-carregador
 * `new Image()`: se a foto quebrar (upload sumido do disco, URL fora do ar), volta pras iniciais.
 */
export default function Avatar({ photoUrl, name, className = '', title, onClick, children, style }: AvatarProps) {
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        setFailed(false);
        if (!photoUrl) return;
        const probe = new Image();
        probe.onerror = () => setFailed(true);
        probe.src = photoUrl;
        return () => { probe.onerror = null; };
    }, [photoUrl]);

    const showPhoto = !!photoUrl && !failed;

    const containerStyle: CSSProperties = {
        position: 'relative', // ancora overlays passados como children
        ...(showPhoto ? {
            backgroundImage: `url(${photoUrl})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
        } : {}),
        ...style,
    };

    return (
        <div className={className} title={title} onClick={onClick} style={containerStyle}>
            {!showPhoto && <span>{computeInitials(name)}</span>}
            {children}
        </div>
    );
}
