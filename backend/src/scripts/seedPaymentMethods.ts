/**
 * Seed default payment method configurations.
 * Run with: npx tsx src/scripts/seedPaymentMethods.ts
 */
import 'dotenv/config';
import { prisma } from '../lib/prisma';



const DEFAULTS = [
  {
    key: 'PIX',
    label: 'PIX',
    shortLabel: 'PIX',
    emoji: '⚡',
    description: 'Pagamento instantâneo',
    color: '#22c55e',
    active: true,
    sortOrder: 0,
    accessMode: 'FULL',
  },
  {
    key: 'CARTAO',
    label: 'Cartão de Crédito',
    shortLabel: 'Cartão',
    emoji: '💳',
    description: 'Crédito ou débito',
    color: '#8b5cf6',
    active: true,
    sortOrder: 1,
    accessMode: 'FULL',
  },
  {
    key: 'BOLETO',
    label: 'Boleto Bancário',
    shortLabel: 'Boleto',
    emoji: '📄',
    description: 'Compensação em até 3 dias úteis',
    color: '#f59e0b',
    active: true,
    sortOrder: 2,
    accessMode: 'PROGRESSIVE',
  },
];

async function main() {
  console.log('Seeding PaymentMethodConfig...');
  for (const d of DEFAULTS) {
    await prisma.paymentMethodConfig.upsert({
      where: { key: d.key },
      create: d,
      update: {},  // don't overwrite if already exists
    });
    console.log(`  ✅ ${d.key} → ${d.label}`);
  }
  console.log('Done!');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
