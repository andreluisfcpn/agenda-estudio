const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const prisma = new PrismaClient();
async function main() {
    const contracts = await prisma.contract.findMany({ include: { bookings: true } });
    const data = contracts.map(c => ({ id: c.id, tier: c.tier, dur: c.durationMonths, type: c.type, bLen: c.bookings.length }));
    fs.writeFileSync('out.json', JSON.stringify(data, null, 2));
}
main().finally(() => prisma.$disconnect());
