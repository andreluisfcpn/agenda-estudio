/** Short label for a card brand. Shared by InlineCheckout and SavedCardItem. */
export function getBrandIcon(brand: string): string {
    const brands: Record<string, string> = {
        visa: 'Visa',
        mastercard: 'MC',
        amex: 'Amex',
        elo: 'Elo',
        hipercard: 'Hiper',
        discover: 'Disc',
    };
    return brands[brand.toLowerCase()] || brand.charAt(0).toUpperCase();
}
