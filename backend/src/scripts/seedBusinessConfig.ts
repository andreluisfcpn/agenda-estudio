/**
 * One-time seed script: populates the business_config table with default values.
 * Run with: npx ts-node -e "require('./src/scripts/seedBusinessConfig')"
 * Or simply: npx tsx src/scripts/seedBusinessConfig.ts
 */
import { prisma } from '../lib/prisma.js';

const configs = [
    // ── Plans ─────────────────────────────────────────────
    { key: 'discount_3months',       value: '30', type: 'percent', label: 'Desconto Fidelidade 3 Meses (%)',    group: 'plans' },
    { key: 'discount_6months',       value: '40', type: 'percent', label: 'Desconto Fidelidade 6 Meses (%)',    group: 'plans' },
    { key: 'sessions_per_month',     value: '4',  type: 'number',  label: 'Sessões por Mês (pacotes 2h)',       group: 'plans' },
    { key: 'episodes_3months',       value: '12', type: 'number',  label: 'Episódios — Plano 3 Meses',          group: 'plans' },
    { key: 'episodes_6months',       value: '24', type: 'number',  label: 'Episódios — Plano 6 Meses',          group: 'plans' },
    // ── Policies ──────────────────────────────────────────
    { key: 'cancellation_fine_pct',         value: '20', type: 'percent', label: 'Multa por Quebra de Contrato (%)',               group: 'policies' },
    { key: 'first_booking_min_days',        value: '1',  type: 'number',  label: 'Mínimo de Dias para 1ª Gravação',                group: 'policies' },
    { key: 'first_booking_max_days',        value: '15', type: 'number',  label: 'Máximo de Dias para 1ª Gravação',                group: 'policies' },
    { key: 'reschedule_max_days',           value: '7',  type: 'number',  label: 'Janela para Reagendamento (dias)',               group: 'policies' },
    { key: 'reschedule_min_hours',          value: '24', type: 'number',  label: 'Antecedência Mínima para Reagendar (horas)',     group: 'policies' },
    { key: 'booking_min_advance_minutes',   value: '30', type: 'number',  label: 'Antecedência Mínima para Agendar (minutos)',    group: 'policies' },
    // ── Payments ──────────────────────────────────────────
    { key: 'pix_extra_discount_pct',    value: '10', type: 'percent', label: 'Desconto Extra PIX à Vista (%)',                 group: 'payments' },
    { key: 'card_fee_3x_pct',           value: '15', type: 'percent', label: 'Taxa Parcelamento Cartão 3x (%)',                group: 'payments' },
    { key: 'card_fee_6x_pct',           value: '20', type: 'percent', label: 'Taxa Parcelamento Cartão 6x (%)',                group: 'payments' },
    { key: 'service_discount_3months',  value: '30', type: 'percent', label: 'Desconto Serviço Mensal 3 Meses (%)',            group: 'payments' },
    { key: 'service_discount_6months',  value: '40', type: 'percent', label: 'Desconto Serviço Mensal 6 Meses (%)',            group: 'payments' },
];

async function main() {
    console.log('Seeding BusinessConfig...');
    for (const cfg of configs) {
        await prisma.businessConfig.upsert({
            where: { key: cfg.key },
            create: cfg,
            update: { label: cfg.label, group: cfg.group, type: cfg.type }, // don't overwrite value if already set
        });
        console.log(`  ✔ ${cfg.key} = ${cfg.value}`);
    }
    console.log('Done!');
    await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
