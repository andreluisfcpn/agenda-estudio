import { coraTestConnection } from './src/lib/coraService';
import { stripeTestConnection } from './src/lib/stripeService';
import { prisma } from './src/lib/prisma';
import fs from 'fs';

async function test() {
    let out = '';
    const log = (msg: string) => out += msg + '\n';
    
    log('--- Testing Integrations ---');
    try {
        log('\nTesting Stripe...');
        const stripeRes = await stripeTestConnection();
        log('Stripe Result: ' + JSON.stringify(stripeRes));
    } catch (e: any) {
        log('Stripe Threw: ' + e.message);
    }
    
    try {
        log('\nTesting Cora...');
        const coraRes = await coraTestConnection();
        log('Cora Result: ' + JSON.stringify(coraRes));
    } catch (e: any) {
        log('Cora Threw: ' + e.message);
    }
    
    await prisma.$disconnect();
    fs.writeFileSync('clean-output.txt', out, 'utf8');
}

test().catch(err => {
    fs.writeFileSync('clean-output.txt', 'Fatal Error: ' + err.message, 'utf8');
    prisma.$disconnect();
});
