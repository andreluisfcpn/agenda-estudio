/**
 * Centralized loading spinner — the markup that was repeated across every page.
 * Prefer page-shaped skeletons (SkeletonLoader) on pages with a hero; use this
 * for small inline / in-modal waits.
 */
export default function LoadingSpinner() {
    return (
        <div className="loading-spinner">
            <div className="spinner" />
        </div>
    );
}
