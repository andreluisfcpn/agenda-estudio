import React from 'react';
import { Check } from 'lucide-react';

interface WizardStepsProps {
    steps: string[];
    /** Passo atual, 1-based. */
    current: number;
    /** Chamado apenas para passos já concluídos (voltar). */
    onStepClick?: (step: number) => void;
}

/**
 * Indicador de passos dos wizards admin — design consolidado do
 * CreateBookingModal (dots com conector, passos concluídos clicáveis,
 * aria-current). Estilos em admin-area.css (.admin-wizard-steps).
 */
export default function WizardSteps({ steps, current, onStepClick }: WizardStepsProps) {
    return (
        <div className="admin-wizard-steps">
            {steps.map((label, i) => {
                const step = i + 1;
                const isActive = current === step;
                const isDone = current > step;
                return (
                    <React.Fragment key={step}>
                        {i > 0 && <div className={`admin-wizard-steps__bar${isDone ? ' admin-wizard-steps__bar--done' : ''}`} />}
                        <button
                            type="button"
                            disabled={!isDone}
                            className={`admin-wizard-steps__step${isActive ? ' admin-wizard-steps__step--active' : ''}${isDone ? ' admin-wizard-steps__step--done' : ''}`}
                            aria-label={isDone ? `Voltar ao passo ${step}: ${label}` : `Passo ${step}: ${label}`}
                            aria-current={isActive ? 'step' : undefined}
                            onClick={() => isDone && onStepClick?.(step)}
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
