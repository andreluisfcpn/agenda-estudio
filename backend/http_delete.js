const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const prisma = new PrismaClient();

async function test() {
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    if (!admin) { console.log('No admin'); return; }

    const token = jwt.sign({ userId: admin.id, role: admin.role, email: admin.email }, process.env.JWT_SECRET || 'secret_dev', { expiresIn: '1h' });

    await prisma.user.deleteMany({ where: { email: 'http_delete_3001@test.com' } });
    const dummy = await prisma.user.create({ data: { name: 'HTTP Delete Test 3001', email: 'http_delete_3001@test.com' } });

    console.log('Dummy:', dummy.id);

    try {
        const res = await fetch('http://localhost:3001/api/users/' + dummy.id, {
            method: 'DELETE',
            headers: {
                'Cookie': 'accessToken=' + token,
                'Content-Type': 'application/json'
            }
        });
        const data = await res.json();
        console.log('HTTP Status:', res.status);
        console.log('Response:', data);
    } catch (e) {
        console.error(e);
    }

    await prisma.$disconnect();
}
test();
