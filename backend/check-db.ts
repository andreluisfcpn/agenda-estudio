import { prisma } from './src/lib/prisma';
async function run() {
    const list = await prisma.integrationConfig.findMany();
    console.log(JSON.stringify(list, null, 2));
    await prisma.$disconnect();
}
run();
