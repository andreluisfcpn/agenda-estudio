import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    console.log("Upserting addons...");

    await prisma.addOnConfig.upsert({
        where: { key: 'CORTES_IA' },
        update: { name: 'Cortes com IA', monthly: false },
        create: { key: 'CORTES_IA', name: 'Cortes com IA', price: 5000, monthly: false, description: 'Cortes gerados por Inteligência Artificial' }
    });

    await prisma.addOnConfig.upsert({
        where: { key: 'CORTES_HUMAN' },
        update: { name: 'Cortes Humanizados', monthly: false },
        create: { key: 'CORTES_HUMAN', name: 'Cortes Humanizados', price: 10000, monthly: false, description: 'Cortes com edição premium direcionada' }
    });

    await prisma.addOnConfig.upsert({
        where: { key: 'PAUTAS' },
        update: { name: 'Criação de Pautas', monthly: false },
        create: { key: 'PAUTAS', name: 'Criação de Pautas', price: 2000, monthly: false, description: 'Especialista em redação para o seu nicho' }
    });

    await prisma.addOnConfig.upsert({
        where: { key: 'YOUTUBE_SEO' },
        update: { name: 'YouTube SEO', monthly: false },
        create: { key: 'YOUTUBE_SEO', name: 'YouTube SEO', price: 3000, monthly: false, description: 'Otimização com tags e métricas para ranqueamento' }
    });

    await prisma.addOnConfig.upsert({
        where: { key: 'GESTAO_SOCIAL' },
        update: { name: 'Gestão de Redes Sociais', monthly: true },
        create: { key: 'GESTAO_SOCIAL', name: 'Gestão de Redes Sociais', price: 50000, monthly: true, description: 'Gestão e postagens mensais em todas as redes' }
    });

    // Optionally cleanup old unsupported ones
    const activeKeys = ['CORTES_IA', 'CORTES_HUMAN', 'PAUTAS', 'YOUTUBE_SEO', 'GESTAO_SOCIAL'];
    await prisma.addOnConfig.deleteMany({
        where: { key: { notIn: activeKeys } }
    });

    console.log("Done.");
}

main().catch(console.error).finally(() => prisma.$disconnect());
