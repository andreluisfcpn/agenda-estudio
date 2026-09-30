import BrandLoader from './ui/BrandLoader';

/**
 * PageTransitionLoader — overlay de carregamento da troca de página (fallback do <Suspense>
 * das rotas). Ocupa a área de conteúdo, entre a Topbar e a barra inferior.
 *
 * A marca (microfone + círculos em órbita) é o `BrandLoader` — o MESMO componente usado no
 * carregamento de dados das telas; aqui só entram o overlay fixo e a barra de progresso.
 */
export function PageTransitionLoader({ exiting = false }: { exiting?: boolean }) {
    return (
        <div className={`ptl${exiting ? ' ptl--exiting' : ''}`}>
            <BrandLoader size="page" label="Carregando página" labelHidden />

            {/* Progress shimmer bar */}
            <div className="ptl__progress" aria-hidden="true">
                <div className="ptl__progress-bar" />
            </div>
        </div>
    );
}
