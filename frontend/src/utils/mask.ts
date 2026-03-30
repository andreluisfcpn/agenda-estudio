/**
 * Formats a numeric string into a Brazilian phone mask: (XX) XXXXX-XXXX or (XX) XXXX-XXXX
 */
export function maskPhone(value: string): string {
    if (!value) return '';

    // Remove all non-digits
    const digits = value.replace(/\D/g, '');

    // Limit to 11 digits
    const limited = digits.slice(0, 11);

    if (limited.length <= 2) {
        return limited.length > 0 ? `(${limited}` : '';
    }
    if (limited.length <= 6) {
        return `(${limited.slice(0, 2)}) ${limited.slice(2)}`;
    }
    if (limited.length <= 10) {
        return `(${limited.slice(0, 2)}) ${limited.slice(2, 6)}-${limited.slice(6)}`;
    }
    return `(${limited.slice(0, 2)}) ${limited.slice(2, 7)}-${limited.slice(7)}`;
}

/**
 * Basic email normalization: lowercase and filter common invalid characters for visual mask
 */
export function maskEmail(value: string): string {
    if (!value) return '';
    // Allow alphanumeric, @, ., -, _
    return value.toLowerCase().replace(/[^a-z0-9@._-]/g, '');
}

/**
 * Removes all non-digit characters
 */
export function unmask(value: string): string {
    return value.replace(/\D/g, '');
}

/**
 * Formats a numeric string into CPF (xxx.xxx.xxx-xx) or CNPJ (xx.xxx.xxx/xxxx-xx)
 */
export function maskCpfCnpj(value: string): string {
    if (!value) return '';
    const digits = value.replace(/\D/g, '').slice(0, 14);
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `${digits.slice(0, 3)}.${digits.slice(3)}`;
    if (digits.length <= 9) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`;
    if (digits.length <= 11) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
    if (digits.length <= 12) return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8)}`;
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
}

/**
 * Translates common backend/zod error messages to Portuguese
 */
export function translateError(message: string, field?: string): string {
    const msg = message.toLowerCase();

    if (msg.includes('must contain at least') || msg.includes('deve ter no mínimo')) {
        const match = msg.match(/(\d+)/);
        const count = match ? match[0] : '6';
        return `Deve conter no mínimo ${count} caracteres.`;
    }
    if (msg.includes('invalid email') || msg.includes('invalid_string') || msg.includes('invalid_type') || msg.includes('e-mail inválido')) {
        return 'E-mail ou formato inválido.';
    }
    if (msg.includes('required') || msg.includes('obrigatória') || msg.includes('obrigatório')) {
        return 'Campo obrigatório.';
    }

    if (msg.includes('already registered') || msg.includes('já cadastrado') || msg.includes('already in use')) {
        return 'Já está cadastrado no sistema.';
    }

    // Default translations for technical terms
    return message
        .replace('String must contain at least', 'Deve conter ao menos')
        .replace('String must contain at most', 'Deve conter no máximo')
        .replace('characters', 'caracteres')
        .replace('character', 'caractere')
        .replace('Invalid', 'Inválido')
        .replace('Required', 'Obrigatório');

}

