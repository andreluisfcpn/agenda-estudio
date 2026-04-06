// ─── Installment Selector ───────────────────────────────
// Grid of installment options with free-interest highlighting

import React from 'react';
import { InstallmentPlan } from '../api/client';

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

interface InstallmentSelectorProps {
    plans: InstallmentPlan[];
    selected: number | null;
    onSelect: (count: number) => void;
    maxFreeInstallments?: number;
}

export default function InstallmentSelector({ plans, selected, onSelect, maxFreeInstallments }: InstallmentSelectorProps) {
    if (plans.length === 0) return null;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingBottom: '4px' }}>
            {plans.map(plan => {
                const isSelected = selected === plan.count;
                const isFree = plan.freeOfCharge;

                return (
                    <button
                        key={plan.count}
                        type="button"
                        onClick={() => onSelect(plan.count)}
                        style={{
                            padding: '12px 16px', borderRadius: '12px',
                            background: isSelected ? 'rgba(16,185,129,0.12)' : 'var(--bg-primary)',
                            border: `2px solid ${isSelected ? '#10b981' : 'var(--border-color)'}`,
                            cursor: 'pointer', textAlign: 'left',
                            transition: 'all 0.2s ease',
                            position: 'relative',
                            overflow: 'hidden',
                        }}
                        onMouseEnter={e => {
                            if (!isSelected) {
                                e.currentTarget.style.borderColor = 'rgba(16,185,129,0.4)';
                                e.currentTarget.style.background = 'rgba(16,185,129,0.04)';
                            }
                        }}
                        onMouseLeave={e => {
                            if (!isSelected) {
                                e.currentTarget.style.borderColor = 'var(--border-color)';
                                e.currentTarget.style.background = 'var(--bg-primary)';
                            }
                        }}
                    >
                        {/* Free badge */}
                        {isFree && plan.count > 1 && (
                            <span style={{
                                position: 'absolute', top: '50%', right: 16, transform: 'translateY(-50%)',
                                fontSize: '0.625rem', fontWeight: 800,
                                color: '#10b981', background: 'rgba(16,185,129,0.12)',
                                padding: '4px 10px', borderRadius: '12px',
                                textTransform: 'uppercase', letterSpacing: '0.05em',
                            }}>
                                Sem juros
                            </span>
                        )}

                        {/* Fee badge */}
                        {!isFree && plan.count > 1 && plan.feePercent > 0 && (
                            <span style={{
                                position: 'absolute', top: '50%', right: 16, transform: 'translateY(-50%)',
                                fontSize: '0.625rem', fontWeight: 700,
                                color: '#f59e0b', background: 'rgba(245,158,11,0.12)',
                                padding: '4px 10px', borderRadius: '12px',
                            }}>
                                +{plan.feePercent.toFixed(1)}%
                            </span>
                        )}

                        {/* Installment count */}
                        <div style={{
                            fontSize: '1rem', fontWeight: 700,
                            color: isSelected ? '#10b981' : 'var(--text-primary)',
                            marginBottom: '2px',
                        }}>
                            {plan.count === 1 ? 'À vista' : `${plan.count}x`}
                            <span style={{
                                fontSize: '0.875rem', fontWeight: 600,
                                color: isSelected ? '#10b981' : 'var(--text-secondary)',
                                marginLeft: '8px',
                            }}>
                                {formatBRL(plan.perInstallment)}
                            </span>
                        </div>

                        {/* Total */}
                        {plan.count > 1 && (
                            <div style={{
                                fontSize: '0.6875rem',
                                color: 'var(--text-muted)',
                            }}>
                                Total: {formatBRL(plan.total)}
                            </div>
                        )}

                        {/* Selected indicator */}
                        {isSelected && (
                            <div style={{
                                position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
                                background: '#10b981', borderRadius: '0 3px 3px 0',
                            }} />
                        )}
                    </button>
                );
            })}
        </div>
    );
}
