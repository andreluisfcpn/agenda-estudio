import React, { createContext, useContext, useCallback } from 'react';
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
 * NavigationProvider — navigates immediately and lets React <Suspense> show the
 * branded loader ONLY while a lazy page chunk is actually downloading.
 *
 * The old implementation forced a fixed ~1s loader on EVERY navigation and ran
 * its own overlay on a timer that didn't coordinate with the chunk download,
 * which stacked two loaders and caused the "flicker / intermediate state".
 * Pages are preloaded on idle (see App.tsx), so cached navigation is instant.
 */
export function NavigationProvider({ children }: { children: React.ReactNode }) {
    const navigate = useNavigate();
    const location = useLocation();

    const navigateTo = useCallback((path: string) => {
        if (path === location.pathname) return;
        navigate(path);
    }, [navigate, location.pathname]);

    return (
        <NavigationContext.Provider value={{ navigateTo, isTransitioning: false, isExiting: false }}>
            {children}
        </NavigationContext.Provider>
    );
}
