// ─── Booking pricing decomposition (display-only, no schema change) ─────────
// Breaks a recording's value into base + per-episode services using the booking's
// addOns, the add-on catalog and the contract loyalty discount. Two billing modes:
//  - Contract booking: `booking.price` is base-only (services are billed in the
//    contract's monthly installment) → total = base + services (services shown as
//    "incluído no contrato").
//  - Avulso booking (no contract): `booking.price` already INCLUDES the services
//    → base = price − services, total = price.

export interface AddonCatalogEntry { name: string; price: number; monthly?: boolean }

export interface BookingServiceLine { key: string; name: string; unitCents: number }

export interface BookingPricingDecomposition {
    baseCents: number;
    servicesCents: number;
    totalCents: number;
    perService: BookingServiceLine[];
}

function applyDiscount(cents: number, discountPct: number): number {
    return Math.round(cents * (1 - (discountPct || 0) / 100));
}

/**
 * @param priceIncludesServices true for avulso bookings (price already has the add-ons),
 *        false for contract bookings (add-ons billed monthly in the contract).
 */
export function decomposeBookingPricing(opts: {
    priceCents: number;
    addOns?: string[] | null;
    addonCatalog: Record<string, AddonCatalogEntry>;
    discountPct?: number;
    priceIncludesServices: boolean;
}): BookingPricingDecomposition {
    const { priceCents, addOns, addonCatalog, discountPct = 0, priceIncludesServices } = opts;
    const perService: BookingServiceLine[] = [];
    let servicesCents = 0;
    for (const key of addOns || []) {
        const cfg = addonCatalog[key];
        if (!cfg || cfg.monthly) continue; // monthly add-ons are not a per-recording cost
        const unitCents = applyDiscount(cfg.price, discountPct);
        perService.push({ key, name: cfg.name, unitCents });
        servicesCents += unitCents;
    }
    const baseCents = priceIncludesServices ? Math.max(0, priceCents - servicesCents) : priceCents;
    const totalCents = priceIncludesServices ? priceCents : priceCents + servicesCents;
    return { baseCents, servicesCents, totalCents, perService };
}
