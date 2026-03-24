const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function test() {
    const users = await prisma.user.findMany({ include: { bookings: true, contracts: true } });

    // Find a test user or someone with bookings we shouldn't fully destroy yet, 
    // Let's just create a dummy one with a contract and a booking, THEN delete it.

    const dummy = await prisma.user.create({
        data: {
            name: 'Complex Dummy',
            email: 'complex_dummy@test.com',
            contracts: {
                create: {
                    name: 'Dummy Contract',
                    type: 'FIXO',
                    tier: 'COMERCIAL',
                    durationMonths: 3,
                    discountPct: 0,
                    startDate: new Date(),
                    endDate: new Date(),
                }
            },
        },
        include: { contracts: true }
    });

    console.log('Created complex dummy with contract:', dummy.id);

    await prisma.booking.create({
        data: {
            userId: dummy.id,
            contractId: dummy.contracts[0].id,
            date: new Date(),
            startTime: '10:00',
            endTime: '12:00',
            tierApplied: 'COMERCIAL',
            price: 10000
        }
    });

    console.log('Created booking');

    // Now let's try the delete logic exactly as the backend does
    try {
        await prisma.payment.deleteMany({ where: { userId: dummy.id } });
        await prisma.booking.deleteMany({ where: { userId: dummy.id } });
        await prisma.contract.deleteMany({ where: { userId: dummy.id } });
        await prisma.blockedSlot.deleteMany({ where: { createdBy: dummy.id } });

        await prisma.user.delete({ where: { id: dummy.id } });
        console.log('Successfully deleted complex dummy!');
    } catch (err) {
        console.error('FAILED TO DELETE DUMMY:', err);
    } finally {
        await prisma.$disconnect();
    }
}
test();
