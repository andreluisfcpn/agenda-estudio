import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useDragScroll } from '../hooks/useDragScroll';
// Nav items come from a single shared source so desktop (Sidebar) and mobile
// (this bar) never drift. All admin tabs live in one horizontally-scrollable
// row (no "More" sheet); labels/icons use the mobile-specific overrides.
import { CLIENT_NAV, ADMIN_NAV } from '../config/nav';

export default function BottomTabBar() {
    const { user } = useAuth();
    const { navigateTo, isTransitioning, pendingPath } = useNavigation();
    const location = useLocation();
    const isAdmin = user?.role === 'ADMIN';
    const items = isAdmin ? ADMIN_NAV : CLIENT_NAV;

    const { ref: barRef, showLeft, showRight, scrollByPage, updateArrows } = useDragScroll<HTMLElement>();
    const activeRef = useRef<HTMLButtonElement>(null);

    // Keep the active tab in view as the route changes.
    useEffect(() => {
        activeRef.current?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        // Recompute arrow visibility after the route-driven scroll settles.
        const t = setTimeout(updateArrows, 400);
        return () => clearTimeout(t);
    }, [location.pathname, updateArrows]);

    return (
        <div className="bottom-tab-bar-wrap scrollrow-wrap">
            {showLeft && (
                <button
                    type="button"
                    className="scrollrow-arrow bottom-tab-arrow scrollrow-arrow--left"
                    aria-label="Rolar para esquerda"
                    onClick={() => scrollByPage(-1)}
                    tabIndex={-1}
                >
                    <ChevronLeft size={16} />
                </button>
            )}
            <nav
                ref={barRef}
                className="bottom-tab-bar scrollrow-track"
                role="tablist"
                aria-label="Navegação principal"
            >
                {items.map(item => {
                    const label = item.shortLabel ?? item.label;
                    const Icon = item.mobileIcon ?? item.icon;
                    // Active state stays bound to the committed location so the highlight and the
                    // on-screen page switch together (no blink). A separate "pending" class gives
                    // immediate tap feedback on the target while the transition resolves.
                    const isActive = location.pathname === item.to;
                    const isPending = isTransitioning && pendingPath === item.to;
                    return (
                        <button
                            key={item.to}
                            ref={isActive ? activeRef : undefined}
                            className={`btb-tab ${isActive ? 'btb-tab--active' : ''} ${isPending ? 'btb-tab--pending' : ''}`}
                            role="tab"
                            aria-label={label}
                            aria-selected={isActive}
                            onClick={() => navigateTo(item.to)}
                        >
                            <Icon size={22} strokeWidth={1.8} className="btb-tab-icon" />
                            <span className="btb-tab-label">{label}</span>
                        </button>
                    );
                })}
            </nav>
            {showRight && (
                <button
                    type="button"
                    className="scrollrow-arrow bottom-tab-arrow scrollrow-arrow--right scrollrow-arrow--pulse"
                    aria-label="Rolar para direita"
                    onClick={() => scrollByPage(1)}
                    tabIndex={-1}
                >
                    <ChevronRight size={16} />
                </button>
            )}
        </div>
    );
}
