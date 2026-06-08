import React from 'react';

interface TimeFieldProps {
    value: string;
    onChange: (hhmm: string) => void;
    'aria-label'?: string;
}

/** Thin wrapper around the native <input type=time> styled like .form-input. */
export default function TimeField({ value, onChange, 'aria-label': ariaLabel }: TimeFieldProps) {
    return (
        <input
            type="time"
            className="form-input sf-time"
            value={value}
            onChange={e => onChange(e.target.value)}
            aria-label={ariaLabel}
        />
    );
}
