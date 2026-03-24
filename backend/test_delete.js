const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function test() {
    try {
        const user = await prisma.user.create({ data: { name: 'Delete Tester', email: 'delete_tester123@test.com' } });
        console.log('Created user:', user.id);

        // Simulate routes.ts delete logic
        await prisma.payment.deleteMany({ where: { userId: user.id } });
        await prisma.booking.deleteMany({ where: { userId: user.id } });
        await prisma.contract.deleteMany({ where: { userId: user.id } });
        await prisma.blockedSlot.deleteMany({ where: { createdBy: user.id } });

        await prisma.user.delete({ where: { id: user.id } });
        console.log('Successfully deleted user');
    } catch (err) {
        console.error('ERROR:', err);
    } finally {
        await prisma.$disconnect();
    }
}
test();
