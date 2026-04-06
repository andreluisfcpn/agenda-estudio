import { randomUUID } from 'crypto';
import { coraCreateBoleto } from './src/lib/coraService';

async function test() {
    try {
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 1);
        
        console.log('Sending to Cora API...');
        const result = await coraCreateBoleto({
            amount: 5000,
            dueDate: dueDate.toISOString().split('T')[0],
            description: 'Teste de PIX QR Code',
            withPixQrCode: true,
            customer: {
                name: 'Cliente Teste Cora',
                email: 'cliente@estudio.com',
                document: { type: 'CPF', identity: '12345678909' }, // Math valid CPF
                address: {
                    street: 'Rua Principal',
                    number: '123',
                    district: 'Centro',
                    city: 'Sao Paulo',
                    state: 'SP',
                    zipCode: '01000000'
                }
            }
        });
        console.log('SUCCESS:', result);
    } catch (e: any) {
        console.error('ERROR OCCURRED:', e.message);
    }
}

test();
