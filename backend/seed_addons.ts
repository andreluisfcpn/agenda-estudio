import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const addons = [
    { key: 'CORTES_IA', name: 'Cortes por IA', price: 50000, description: 'Acima de 10 cortes de vídeo (vertical ou horizontal) com legenda.' },
    { key: 'CORTES_HUMANO', name: 'Cortes feitos por Humano', price: 80000, description: 'Acima de 5 cortes de vídeo (vertical ou horizontal) com edição refinada e legenda.' },
    { key: 'GESTAO_SOCIAL', name: 'Gestão de Rede Social', price: 200000, description: 'Postagem no YouTube e Instagram, contato com convidados para gravar vídeos de apresentação, criação de making-of e rotina de postagens.' },
    { key: 'YOUTUBE_SEO', name: 'YouTube SEO', price: 20000, description: 'Criação de miniatura (thumbnail), título, descrição, palavras-chaves e tudo o que é necessário para o cliente apenas sentar e gravar.' },
    { key: 'PAUTAS', name: 'Criação de Pautas', price: 30000, description: 'Pesquisa sobre o convidado e criação de pauta completa.' },
  ];

  for (const addon of addons) {
    await prisma.addOnConfig.upsert({
      where: { key: addon.key },
      update: addon,
      create: addon,
    });
  }
  console.log('Add-ons seeded successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
