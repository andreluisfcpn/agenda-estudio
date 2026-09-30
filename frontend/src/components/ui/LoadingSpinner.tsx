import BrandLoader from './BrandLoader';

/**
 * Loading de seção — desde o lote 2 (E5) é o loading de MARCA (microfone com os círculos em órbita),
 * não mais o anel genérico `.spinner`. Mantido como atalho para os chamadores antigos; em código novo
 * use `<BrandLoader size="page|section|inline" label="…" />` direto.
 * Páginas com herói/tabela continuam com os esqueletos de `SkeletonLoader`.
 */
export default function LoadingSpinner({ label }: { label?: string } = {}) {
    return <BrandLoader size="section" label={label} />;
}
