import React from 'react';
import { Check } from 'lucide-react';

interface WizardStepsProps {
    steps: string[];
    /** Passo atual, 1-based. */
    current: number;
    /**
     * Chamado ao clicar num passo. Sem `allowJump`, só passos já concluídos
     * (voltar); com `allowJump`, qualquer passo que não seja o atual.
     * Passe o `goTo` do hook `useWizardStep`.
     */
    onStepClick?: (step: number) => void;
    /**
     * Modo EDIÇÃO: todos os passos (inclusive os seguintes) ficam clicáveis,
     * para pular direto a qualquer etapa. Sem a prop, comportamento original
     * (só concluídos são clicáveis). Quem usa deve validar TODAS as etapas no
     * salvar, já que é possível chegar à última sem passar pelas anteriores.
     */
    allowJump?: boolean;
}

/**
 * Indicador de passos dos wizards admin — design consolidado do
 * CreateBookingModal (dots com conector, passos concluídos clicáveis,
 * aria-current). Estilos em admin-area.css (.admin-wizard-steps).
 */
export default function WizardSteps({ steps, current, onStepClick, allowJump = false }: WizardStepsProps) {
    return (
        <div className="admin-wizard-steps">
            {steps.map((label, i) => {
                const step = i + 1;
                const isActive = current === step;
                const isDone = current > step;
                const canClick = allowJump ? !isActive : isDone;
                const isJumpAhead = allowJump && !isDone && !isActive;
                const ariaLabel = isDone
                    ? `Voltar ao passo ${step}: ${label}`
                    : isJumpAhead
                        ? `Ir ao passo ${step}: ${label}`
                        : `Passo ${step}: ${label}`;
                return (
                    <React.Fragment key={step}>
                        {i > 0 && <div className={`admin-wizard-steps__bar${isDone ? ' admin-wizard-steps__bar--done' : ''}`} />}
                        <button
                            type="button"
                            disabled={!canClick}
                            className={`admin-wizard-steps__step${isActive ? ' admin-wizard-steps__step--active' : ''}${isDone ? ' admin-wizard-steps__step--done' : ''}`}
                            aria-label={ariaLabel}
                            aria-current={isActive ? 'step' : undefined}
                            // Passo à frente clicável (só com allowJump): o CSS base dá cursor
                            // pointer apenas a --done; aqui o valor depende da prop.
                            style={isJumpAhead ? { cursor: 'pointer' } : undefined}
                            onClick={() => canClick && onStepClick?.(step)}
                        >
                            <span className="admin-wizard-steps__dot">
                                {isDone ? <Check size={13} aria-hidden="true" /> : step}
                            </span>
                            <span className="admin-wizard-steps__label">{label}</span>
                        </button>
                    </React.Fragment>
                );
            })}
        </div>
    );
}
