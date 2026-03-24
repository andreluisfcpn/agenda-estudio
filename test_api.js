const http = require('http');

const data = JSON.stringify({ email: 'djfixo@email.com', password: '123456' });

const req = http.request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/auth/login',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
    }
}, (res) => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => {
        const cookies = res.headers['set-cookie'];
        const p = http.request({
            hostname: 'localhost',
            port: 3000,
            path: '/api/contracts/my',
            method: 'GET',
            headers: { 'Cookie': cookies ? cookies[0] : '' }
        }, (res2) => {
            let body2 = '';
            res2.on('data', d => body2 += d);
            res2.on('end', () => console.log(body2));
        });
        p.end();
    });
});
req.write(data);
req.end();
