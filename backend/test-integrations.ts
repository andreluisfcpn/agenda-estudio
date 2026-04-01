import { coraTestConnection } from './src/lib/coraService';
import { stripeTestConnection } from './src/lib/stripeService';
import { isCoraEnabled, coraAuthenticate } from './src/lib/coraService';
import { isStripeEnabled } from './src/lib/stripeService';
import { prisma } from './src/lib/prisma';

async function test() {
    console.log('--- Testing Integrations ---');
    console.log('Cora Enabled:', await isCoraEnabled());
    console.log('Stripe Enabled:', await isStripeEnabled());
    
    console.log('\nTesting Stripe Connection...');
    const stripeRes = await stripeTestConnection();
    console.log('Stripe Result:', stripeRes);
    
    console.log('\nTesting Cora Connection...');
    const coraRes = await coraTestConnection();
    console.log('Cora Result:', coraRes);
    
    await prisma.$disconnect();
}

test().catch(err => {
    console.error('Fatal Test Error:', err);
    prisma.$disconnect();
});
