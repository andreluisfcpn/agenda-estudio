import React from 'react';
import { AlertTriangle } from 'lucide-react';

interface Props { children: React.ReactNode; }
interface State { hasError: boolean; }

/**
 * Barreira de erro de render: sem ela, qualquer exceção num componente
 * derruba a árvore inteira (tela branca). O fallback mantém o usuário
 * no app com uma saída óbvia (recarregar).
 */
export default class ErrorBoundary extends React.Component<Props, State> {
    state: State = { hasError: false };

    static getDerivedStateFromError(): State {
        return { hasError: true };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        console.error('[ErrorBoundary]', error, info.componentStack);
    }

    render() {
        if (!this.state.hasError) return this.props.children;
        return (
            <div className="error-boundary" role="alert">
                <AlertTriangle size={40} className="error-boundary__icon" aria-hidden="true" />
                <h2 className="error-boundary__title">Algo deu errado</h2>
                <p className="error-boundary__message">
                    Ocorreu um erro inesperado nesta tela. Recarregue a página para continuar.
                </p>
                <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => window.location.reload()}
                >
                    Recarregar página
                </button>
            </div>
        );
    }
}
