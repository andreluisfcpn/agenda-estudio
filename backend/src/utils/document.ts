// ─── CPF/CNPJ validation (módulo-11 check digits) ───────
// Shared, framework-agnostic validators for Brazilian tax documents.
// Used by the profile-update endpoint and the Cora payment helper.

/** Strips every non-digit character. */
export function cleanDocument(value: string | null | undefined): string {
    return (value || '').replace(/\D/g, '');
}

/** Validates a CPF (11 digits) using the official check-digit algorithm. */
export function isValidCpf(value: string | null | undefined): boolean {
    const cpf = cleanDocument(value);
    if (cpf.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(cpf)) return false; // reject 000.000.000-00 etc.

    let sum = 0;
    for (let i = 0; i < 9; i++) sum += parseInt(cpf[i]!, 10) * (10 - i);
    let d1 = 11 - (sum % 11);
    if (d1 >= 10) d1 = 0;
    if (d1 !== parseInt(cpf[9]!, 10)) return false;

    sum = 0;
    for (let i = 0; i < 10; i++) sum += parseInt(cpf[i]!, 10) * (11 - i);
    let d2 = 11 - (sum % 11);
    if (d2 >= 10) d2 = 0;
    return d2 === parseInt(cpf[10]!, 10);
}

/** Validates a CNPJ (14 digits) using the official check-digit algorithm. */
export function isValidCnpj(value: string | null | undefined): boolean {
    const cnpj = cleanDocument(value);
    if (cnpj.length !== 14) return false;
    if (/^(\d)\1{13}$/.test(cnpj)) return false;

    const calc = (len: number): number => {
        const weights = len === 12
            ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
            : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
        let sum = 0;
        for (let i = 0; i < len; i++) sum += parseInt(cnpj[i]!, 10) * weights[i]!;
        const r = sum % 11;
        return r < 2 ? 0 : 11 - r;
    };

    if (calc(12) !== parseInt(cnpj[12]!, 10)) return false;
    return calc(13) === parseInt(cnpj[13]!, 10);
}

/** True when the value is a valid CPF (11 digits) or CNPJ (14 digits). */
export function isValidCpfCnpj(value: string | null | undefined): boolean {
    const digits = cleanDocument(value);
    if (digits.length === 11) return isValidCpf(digits);
    if (digits.length === 14) return isValidCnpj(digits);
    return false;
}
