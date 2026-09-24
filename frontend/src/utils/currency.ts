// ─── Moeda (R$) para campos de entrada ─────────────────────────────────────
// Funções puras usadas pelo CurrencyInput (modo "banco": os dígitos entram da
// direita para a esquerda) e por qualquer tela que precise interpretar um valor
// colado/digitado em reais. Todos os valores são CENTAVOS inteiros — o mesmo
// formato do backend (Prisma Int + zod int).
//
// Para EXIBIR um valor (fora de input) continue usando `formatBRL` de utils/format.

/** Teto padrão: R$ 9.999.999,99 (abaixo do Int32 do Postgres, ~R$ 21,4 mi). */
export const MAX_CENTS = 999_999_999;

/** Remove tudo que não for dígito. */
export function onlyDigits(s: string): string {
    return String(s ?? '').replace(/\D/g, '');
}

/** Quantidade de dígitos em `s` (ignora separadores e qualquer outro caractere). */
export function countDigits(s: string): number {
    return onlyDigits(s).length;
}

/**
 * Centavos → texto do campo, SEM prefixo: 123456 → "1.234,56"; 5 → "0,05".
 * Montado à mão (sem Intl) para não depender dos dados de locale do navegador
 * (alguns WebViews Android sem ICU completo formatam pt-BR como en-US).
 */
export function formatCentsInput(cents: number): string {
    const c = Number.isFinite(cents) ? Math.max(0, Math.round(cents)) : 0;
    const s = String(c);
    const intPart = s.length > 2 ? s.slice(0, -2) : '0';
    const frac = s.padStart(3, '0').slice(-2);
    return `${intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${frac}`;
}

/**
 * Dígitos digitados (modo banco) → centavos: "30000" → 30000 (R$ 300,00).
 * Zeros à esquerda são ignorados. Uma sequência longa demais para ser um valor
 * real vira `Infinity`, para o chamador rejeitar pelo teto (`max`).
 */
export function digitsToCents(digits: string): number {
    const d = onlyDigits(digits).replace(/^0+/, '');
    if (!d) return 0;
    if (d.length > 15) return Number.POSITIVE_INFINITY;
    return Number(d);
}

/**
 * Interpreta um valor COLADO (ou escrito livremente) em reais → centavos.
 * O último "." ou "," seguido de 1–2 dígitos no fim é o separador decimal;
 * qualquer outro separador é de milhar. Símbolos, espaços e letras são ignorados.
 *
 *   "R$ 1.500,00" → 150000   "1.500,00" → 150000   "1500"  → 150000
 *   "450.00"      → 45000    "1,500.00" → 150000   "1.500" → 150000
 *   "0,5"         → 50       ",99"      → 99       "abc"   → null
 *
 * Devolve `null` quando não há nenhum dígito. Não aplica teto (o chamador decide).
 */
export function parseBRLToCents(raw: string): number | null {
    const cleaned = String(raw ?? '').replace(/[^\d.,]/g, '');
    if (!/\d/.test(cleaned)) return null;

    const lastSep = Math.max(cleaned.lastIndexOf(','), cleaned.lastIndexOf('.'));
    let intDigits: string;
    let fracDigits = '';
    if (lastSep >= 0) {
        const after = cleaned.slice(lastSep + 1); // só dígitos: é o ÚLTIMO separador
        if (after.length >= 1 && after.length <= 2) {
            intDigits = onlyDigits(cleaned.slice(0, lastSep));
            fracDigits = after;
        } else {
            // 0 dígitos (separador solto no fim) ou ≥3 dígitos (milhar) → tudo é parte inteira
            intDigits = onlyDigits(cleaned);
        }
    } else {
        intDigits = cleaned;
    }

    const intClean = intDigits.replace(/^0+/, '');
    if (intClean.length > 13) return Number.MAX_SAFE_INTEGER; // absurdo → o teto do chamador rejeita
    const reais = intClean ? Number(intClean) : 0;
    const cents = Number((fracDigits + '00').slice(0, 2));
    return reais * 100 + cents;
}

/**
 * Posição do cursor em `formatted` que deixa exatamente `digitsRight` dígitos à
 * sua direita, encostada no dígito anterior (ex.: "12.347,56" com 2 → índice 6,
 * logo após o "7"). Mantém o cursor estável quando a reformatação insere/remove
 * pontos de milhar.
 */
export function caretForDigitsRight(formatted: string, digitsRight: number): number {
    if (digitsRight <= 0) return formatted.length;
    let seen = 0;
    for (let i = formatted.length - 1; i >= 0; i--) {
        if (formatted[i] >= '0' && formatted[i] <= '9') {
            if (seen === digitsRight) return i + 1;
            seen++;
        }
    }
    return 0;
}
