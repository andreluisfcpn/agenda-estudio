import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
    const payments = await prisma.payment.findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, createdAt: true, amount: true, pixString: true, boletoUrl: true }
    });
    console.log(JSON.stringify(payments, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
