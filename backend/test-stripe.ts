import { prisma } from './src/lib/prisma';
import { stripeGetOrCreateCustomer } from './src/lib/stripeService';

async function test() {
    try {
        const user = await prisma.user.findFirst();
        if (!user) return console.log("No user");
        console.log("Initial stripeCustomerId:", user.stripeCustomerId);

        const customerId = await stripeGetOrCreateCustomer(user.id);
        console.log("Returned customerId:", customerId);
        
        const updated = await prisma.user.findUnique({where:{id:user.id}});
        console.log("Updated DB stripeCustomerId:", updated?.stripeCustomerId);
    } catch(err) {
        console.error("Script error:", err);
    }
}
test();
