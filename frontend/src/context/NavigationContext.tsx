import React, { createContext, useContext, useCallback, useTransition, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

interface NavigationContextType {
    /** Navigate inside a React transition (keeps the current page until the next is ready). */
    navigateTo: (path: string) => void;
    /** True while a navigation transition is pending (target chunk/render not committed yet). */
    isTransitioning: boolean;
    /** Path being navigated TO during a pending transition (null when idle). */
    pendingPath: string | null;
    /** Kept for API compatibility (no separate exit phase anymore). */
    isExiting: boolean;
}

const NavigationContext = createContext<NavigationContextType>({
    navigateTo: () => {},
    isTransitioning: false,
    pendingPath: null,
    isExiting: false,
});

export function useNavigation() {
    return useContext(NavigationContext);
}

/**
 * NavigationProvider — navigates inside `useTransition` so React 19 keeps the CURRENT
 * page visible until the target route's lazy chunk + first render are ready, then commits
 * the URL and the new page together. This removes the full-screen `<Suspense>` loader
 * flash (`.ptl`) that previously blinked between tab states, so the selected tab always
 * matches what's on screen. Pages are preloaded on idle (App.tsx), so it's usually instant;
 * the Suspense fallback only appears if a transition genuinely takes long (uncached chunk).
 */
export function NavigationProvider({ children }: { children: React.ReactNode }) {
    const navigate = useNavigate();
    const location = useLocation();
    const [isPending, startTransition] = useTransition();
    const [pendingPath, setPendingPath] = useState<string | null>(null);

    const navigateTo = useCallback((path: string) => {
        if (path === location.pathname) return;
        setPendingPath(path);
        startTransition(() => {
            navigate(path);
        });
    }, [navigate, location.pathname]);

    // Clear the pending target once the location actually reflects it.
    React.useEffect(() => {
        if (pendingPath && location.pathname === pendingPath) setPendingPath(null);
    }, [location.pathname, pendingPath]);

    return (
        <NavigationContext.Provider value={{ navigateTo, isTransitioning: isPending, pendingPath, isExiting: false }}>
            {children}
        </NavigationContext.Provider>
    );
}
