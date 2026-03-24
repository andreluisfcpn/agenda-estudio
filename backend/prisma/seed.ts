import { PrismaClient, Role, Tier, ContractType, ContractStatus, BookingStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
    console.log('🌱 Wiping database and seeding comprehensive edge cases...');

    // Clean existing data
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

    console.log('\n✨ Database Reset completed successfully!');
    console.log('\nCredenciais limitadas prontas para teste:');
    console.log('  🛡️ Admin:     admin@studio.com (admin123)');
    console.log('  👤 Cliente:   cliente@teste.com (cliente123)');
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
