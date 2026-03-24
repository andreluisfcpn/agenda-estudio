const { z } = require('zod');

const schema = z.string().email();

const emails = [
    'test@gmail.com',
    'test@buzios.digital',
    'admin@buzios.studio',
    'contato@buzios.digital'
];

emails.forEach(email => {
    try {
        schema.parse(email);
        console.log(`✅ ${email} is valid`);
    } catch (e) {
        console.log(`❌ ${email} is invalid`);
    }
});
