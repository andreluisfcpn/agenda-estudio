/**
 * One-time seed script: populates the business_config table with default values.
 * Run with: npx ts-node -e "require('./src/scripts/seedBusinessConfig')"
 * Or simply: npx tsx src/scripts/seedBusinessConfig.ts
 */
import { prisma } from '../lib/prisma.js';
import { BUSINESS_CONFIG_CATALOG } from '../config/businessConfigCatalog.js';

const configs = BUSINESS_CONFIG_CATALOG;

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
