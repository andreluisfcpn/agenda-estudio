interface SectionHeaderProps {
    num: number;
    label: string;
    /** Cor do círculo numerado (default: teal legível). */
    color?: string;
}

/**
 * Cabeçalho numerado de seção de formulário — substitui o helper
 * `sectionHeader(num, text, color)` duplicado em CouponModal e
 * CreateContractModal. Estilos em admin-area.css (.admin-section-header).
 */
export default function SectionHeader({ num, label, color = 'var(--accent-text)' }: SectionHeaderProps) {
    return (
        <div className="admin-section-header">
            <span className="admin-section-header__num" style={{ background: color }}>{num}</span>
            {label}
        </div>
    );
}
