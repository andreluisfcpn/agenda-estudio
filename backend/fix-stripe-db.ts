import { prisma } from './src/lib/prisma';
async function run() {
    await prisma.integrationConfig.update({
        where: { provider: 'STRIPE' },
        data: {
            config: JSON.stringify({
                secretKey: "sk_test_fake_secret_for_test",
                publishableKey: "pk_test_fake456",
                webhookSecret: "whsec_fake789"
            })
        }
    });
    console.log("Stripe mock key added to DB.");
    await prisma.$disconnect();
}
run();
