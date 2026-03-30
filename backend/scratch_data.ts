import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    let user = await prisma.user.findFirst({ where: { role: 'CLIENTE', email: 'cliente@test.com' } });
    if (!user) {
        user = await prisma.user.findFirst({ where: { role: 'CLIENTE' } });
    }
    if (!user) {
        console.log("No client found");
        return;
    }

    // create a CUSTOM contract
    const d = new Date();
    const contract = await prisma.contract.create({
        data: {
            userId: user.id,
            name: "Plano Teste Remarcação",
            type: "CUSTOM",
            tier: "COMERCIAL",
            durationMonths: 1,
            discountPct: 0,
            status: "ACTIVE",
            startDate: new Date(),
            endDate: new Date(d.getTime() + 30 * 24 * 60 * 60 * 1000),
            sessionsPerCycle: 4,
            customCreditsRemaining: 0,
            accessMode: "FULL",
        }
    });

    // create a FUTURE booking (> 24h)
    const bookDate = new Date();
    bookDate.setDate(bookDate.getDate() + 5); 
    const dateStr = bookDate.toISOString().split('T')[0];

    await prisma.booking.create({
        data: {
            userId: user.id,
            contractId: contract.id,
            date: new Date(dateStr + "T00:00:00.000Z"),
            startTime: "13:00",
            endTime: "15:00",
            status: "CONFIRMED",
            tierApplied: "COMERCIAL",
            price: 0
        }
    });

    console.log("Test data created successfully! Email to login:", user.email);
}

main().catch(console.error).finally(() => prisma.$disconnect());
