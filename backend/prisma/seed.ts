import 'dotenv/config';
import { PrismaClient, Role, Tier, ContractType, ContractStatus, BookingStatus } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
    console.log('🌱 Wiping database and seeding comprehensive edge cases...');

    // Clean existing data
    await prisma.savedPaymentMethod.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.booking.deleteMany();
    await prisma.blockedSlot.deleteMany();
    await prisma.contract.deleteMany();
    await prisma.user.deleteMany();

    const clientPassword = await bcrypt.hash('cliente123', 12);
    const adminPassword = await bcrypt.hash('admin123', 12);

    // ─── 1. Admin User ──────────────────────────────────────────
    const admin = await prisma.user.create({
        data: {
            email: 'admin@studio.com',
            passwordHash: adminPassword,
            name: 'Administrador',
            phone: '(21) 99999-0000',
            role: Role.ADMIN,
        },
    });
    console.log(`  ✅ Admin: ${admin.email} / admin123`);

    const now = new Date();
    const oneMonthAgo = new Date(now); oneMonthAgo.setMonth(now.getMonth() - 1);
    const twoMonthsAgo = new Date(now); twoMonthsAgo.setMonth(now.getMonth() - 2);
    const threeMonthsLater = new Date(now); threeMonthsLater.setMonth(now.getMonth() + 3);
    const sixMonthsLater = new Date(now); sixMonthsLater.setMonth(now.getMonth() + 6);

    // ─── 2. New Client (No Contracts) ───────────────────────────
    const newClient = await prisma.user.create({
        data: {
            email: 'cliente@teste.com',
            passwordHash: clientPassword,
            name: 'Cliente Principal',
            phone: '(21) 91111-1111',
            role: Role.CLIENTE,
        },
    });
    console.log(`  ✅ Cliente Novo: ${newClient.email}`);

    // ─── 3. Business Config (upsert new groups) ────────────────
    const configEntries = [
        // schedule
        { key: 'time_slots',        value: '10:00,13:00,15:30,18:00,20:30', type: 'string',  label: 'Horários dos Blocos',           group: 'schedule' },
        { key: 'slot_duration_hours', value: '2',                            type: 'number',  label: 'Duração do Bloco (horas)',      group: 'schedule' },
        { key: 'comercial_slots',    value: '10:00,13:00,15:30',            type: 'string',  label: 'Horários Faixa Comercial',      group: 'schedule' },
        { key: 'audiencia_slots',    value: '18:00,20:30',                  type: 'string',  label: 'Horários Faixa Audiência',      group: 'schedule' },
        { key: 'operating_days',     value: '1,2,3,4,5,6',                  type: 'string',  label: 'Dias de Funcionamento (1=Seg…6=Sáb)', group: 'schedule' },
        { key: 'close_time',         value: '23:00',                        type: 'string',  label: 'Horário de Fechamento',          group: 'schedule' },
        // gateway
        { key: 'gateway_stripe_fee_pct', value: '4',   type: 'percent', label: 'Taxa Stripe (%)',              group: 'gateway' },
        { key: 'gateway_cora_fee_cents', value: '200', type: 'number',  label: 'Taxa Cora por Boleto (centavos)', group: 'gateway' },
        // studio
        { key: 'studio_name',        value: 'Estúdio Búzios Digital',       type: 'string',  label: 'Nome do Estúdio',                group: 'studio' },
        { key: 'studio_logo_url',    value: 'https://buzios.digital/wp-content/uploads/2025/01/logo-site-branca.svg', type: 'string', label: 'URL do Logo', group: 'studio' },
        { key: 'studio_email',       value: 'contato@buzios.digital',       type: 'string',  label: 'E-mail de Contato',              group: 'studio' },
        { key: 'studio_hero_image',  value: 'https://buzios.digital/wp-content/uploads/elementor/thumbs/bd-estudio-enhanced-sr-r9lm9twze86yo0wxu68fp1e0yf8baho28zrniyf1o0.jpg', type: 'string', label: 'Imagem Principal', group: 'studio' },
        { key: 'studio_location',    value: 'Búzios, RJ',                   type: 'string',  label: 'Localização',                    group: 'studio' },
    ];

    for (const entry of configEntries) {
        await prisma.businessConfig.upsert({
            where: { key: entry.key },
            create: entry,
            update: {},  // don't overwrite existing values
        });
    }
    console.log(`  ✅ Business config: ${configEntries.length} chaves (schedule/gateway/studio)`);

    console.log('\n✨ Database Reset completed successfully!');
    console.log('\nCredenciais limitadas prontas para teste:');
    console.log('  🛡️ Admin:     admin@studio.com (admin123)');
    console.log('  👤 Cliente:   cliente@teste.com (cliente123)');
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
