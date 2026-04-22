/**
 * PageTransitionLoader — Animated loading overlay shown during
 * page transitions. Renders inside the content area between
 * Topbar and BottomTabBar, centered on the visible viewport.
 *
 * Uses: orbiting dots, pulsing core, shimmer progress bar.
 * GPU-accelerated via CSS animations.
 */
export function PageTransitionLoader({ exiting = false }: { exiting?: boolean }) {
    return (
        <div
            className={`ptl${exiting ? ' ptl--exiting' : ''}`}
            role="status"
            aria-label="Carregando página"
        >
            {/* Ambient glow */}
            <div className="ptl__glow" />

            {/* Central loader animation */}
            <div className="ptl__center">
                {/* Orbiting ring */}
                <div className="ptl__orbit">
                    <div className="ptl__orbit-dot ptl__orbit-dot--1" />
                    <div className="ptl__orbit-dot ptl__orbit-dot--2" />
                    <div className="ptl__orbit-dot ptl__orbit-dot--3" />
                </div>

                {/* Pulsing core */}
                <div className="ptl__core">
                    <div className="ptl__core-ring" />
                    <div className="ptl__core-ring ptl__core-ring--delayed" />
                    <svg className="ptl__logo" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        {/* Mic capsule */}
                        <path
                            d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="ptl__logo-path"
                        />
                        {/* Mic arm */}
                        <path
                            d="M19 10v2a7 7 0 0 1-14 0v-2"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="ptl__logo-path"
                        />
                        {/* Mic stand */}
                        <path
                            d="M12 19v3M8 22h8"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="ptl__logo-path"
                        />
                    </svg>
                </div>
            </div>

            {/* Progress shimmer bar */}
            <div className="ptl__progress">
                <div className="ptl__progress-bar" />
            </div>
        </div>
    );
}
