import { prisma } from './src/lib/prisma';
import fs from 'fs';
async function run() {
    const list = await prisma.integrationConfig.findMany();
    fs.writeFileSync('clean-db.json', JSON.stringify(list, null, 2), 'utf8');
    await prisma.$disconnect();
}
run();
