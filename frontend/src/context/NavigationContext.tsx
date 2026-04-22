import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

interface NavigationContextType {
    /** Start a transition: show loader → wait → navigate */
    navigateTo: (path: string) => void;
    /** True while the loader overlay is visible */
    isTransitioning: boolean;
    /** True during the fade-out phase */
    isExiting: boolean;
}

const NavigationContext = createContext<NavigationContextType>({
    navigateTo: () => {},
    isTransitioning: false,
    isExiting: false,
});

export function useNavigation() {
    return useContext(NavigationContext);
}

/**
 * NavigationProvider — Intercepts page navigation to show a loader
 * BEFORE the route change, preventing the "flash" effect.
 *
 * Flow: click → show loader → min delay → navigate → fade out loader
 */
export function NavigationProvider({ children }: { children: React.ReactNode }) {
    const navigate = useNavigate();
    const location = useLocation();
    const [isTransitioning, setIsTransitioning] = useState(false);
    const [isExiting, setIsExiting] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const targetRef = useRef<string | null>(null);

    const cleanup = useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const navigateTo = useCallback((path: string) => {
        // Don't transition if already on this page
        if (path === location.pathname) return;
        // Don't double-trigger
        if (isTransitioning && targetRef.current === path) return;

        cleanup();
        targetRef.current = path;

        // Phase 1: Show loader immediately
        setIsTransitioning(true);
        setIsExiting(false);

        // Phase 2: After minimum display time, navigate to target
        timerRef.current = setTimeout(() => {
            navigate(path);

            // Phase 3: Small delay to let the new route render under the loader
            timerRef.current = setTimeout(() => {
                // Phase 4: Start fade-out
                setIsExiting(true);

                // Phase 5: Remove overlay after fade-out animation
                timerRef.current = setTimeout(() => {
                    setIsTransitioning(false);
                    setIsExiting(false);
                    targetRef.current = null;
                }, 300); // CSS fade-out duration
            }, 150); // Let React render the new page behind the overlay
        }, 600); // Minimum loader display time
    }, [navigate, location.pathname, isTransitioning, cleanup]);

    return (
        <NavigationContext.Provider value={{ navigateTo, isTransitioning, isExiting }}>
            {children}
        </NavigationContext.Provider>
    );
}
