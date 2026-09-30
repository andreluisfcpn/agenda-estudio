import '../../styles/brand-loader.css';

export type BrandLoaderSize = 'page' | 'section' | 'compact' | 'inline';

interface BrandLoaderProps {
    /**
     * `page` — carregamento da página inteira (marca de 80px, bloco alto);
     * `section` — um bloco/seção da página (padrão);
     * `compact` — tela de "processando" dentro de um modal/wizard ("Gerando pagamento…"): marca de 40px,
     *   sem altura mínima nem padding próprios (o container decide), com o `label` logo abaixo;
     * `inline` — ao lado de um texto ("Atualizando…"), sem ocupar o layout.
     */
    size?: BrandLoaderSize;
    /** Texto exibido junto da marca. Sem ele, "Carregando…" vai só para o leitor de tela. */
    label?: string;
    /** Mantém o `label` apenas para leitor de tela (a marca aparece sozinha). */
    labelHidden?: boolean;
    className?: string;
}

/**
 * Loading de marca do sistema: o microfone com os círculos girando em volta (o mesmo visual do
 * loading de troca de página da área do cliente — o `PageTransitionLoader` reutiliza este componente).
 *
 * Use onde a tela espera dados e NÃO existe um esqueleto (blocos cinza) com a forma do conteúdo.
 * Botões em andamento ("Salvando…") continuam com o spinner pequeno. `role="status"` + `aria-live`
 * anunciam o estado; em `prefers-reduced-motion` a marca fica estática (brand-loader.css).
 */
export default function BrandLoader({ size = 'section', label, labelHidden = false, className }: BrandLoaderProps) {
    const text = label?.trim() || 'Carregando…';
    const showLabel = !!label?.trim() && !labelHidden;
    return (
        <span
            className={`brand-loader brand-loader--${size}${className ? ` ${className}` : ''}`}
            role="status"
            aria-live="polite"
        >
            <span className="brand-loader__mark" aria-hidden="true">
                <span className="brand-loader__glow" />
                <span className="brand-loader__orbit">
                    <span className="brand-loader__dot brand-loader__dot--1" />
                    <span className="brand-loader__dot brand-loader__dot--2" />
                    <span className="brand-loader__dot brand-loader__dot--3" />
                </span>
                <span className="brand-loader__core">
                    <span className="brand-loader__ring" />
                    <span className="brand-loader__ring brand-loader__ring--delayed" />
                    <svg className="brand-loader__mic" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" focusable="false">
                        {/* Cápsula, haste e base do microfone */}
                        <path className="brand-loader__mic-path" d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        <path className="brand-loader__mic-path" d="M19 10v2a7 7 0 0 1-14 0v-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        <path className="brand-loader__mic-path" d="M12 19v3M8 22h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                </span>
            </span>
            {showLabel
                ? <span className="brand-loader__label">{text}</span>
                : <span className="brand-loader__sr">{text}</span>}
        </span>
    );
}
