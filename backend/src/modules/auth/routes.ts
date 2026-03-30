import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { prisma } from '../../lib/prisma';
import { config } from '../../config';
import { authenticate } from '../../middleware/auth';
import { OAuth2Client } from 'google-auth-library';
import { otpService } from '../../lib/otp';

const googleClient = new OAuth2Client(process.env.VITE_GOOGLE_CLIENT_ID);


const router = Router();

// ─── Multer for photo uploads (memory storage) ──────────
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB raw
    fileFilter: (_req: any, file: any, cb: any) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Apenas imagens são permitidas.'));
    },
});

// Uploads directory — resolve from project root
const UPLOADS_DIR = path.resolve(__dirname, '../../../uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── Validation Schemas ─────────────────────────────────

const registerSchema = z.object({
    email: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'E-mail inválido'),
    password: z.string().min(6, 'Deve conter no mínimo 6 caracteres'),
    name: z.string().min(2, 'Deve conter no mínimo 2 caracteres'),
    phone: z.string().min(10, 'Telefone inválido'),
    code: z.string().min(6, 'Código inválido').max(6),
    method: z.enum(['email', 'phone']),
});


const loginSchema = z.object({
    email: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'E-mail inválido'),
    password: z.string().min(1, 'Senha obrigatória'),
});

const googleLoginSchema = z.object({
    idToken: z.string().min(1)
});

const otpSendSchema = z.object({
    phone: z.string().min(10, 'Telefone inválido'),
    name: z.string().min(2, 'Nome inválido'),
    email: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'E-mail inválido'),
    password: z.string().min(6, 'Deve conter no mínimo 6 caracteres')
});


const otpVerifySchema = z.object({
    phone: z.string().min(1, 'Telefone obrigatório'),
    code: z.string().min(6, 'Código inválido').max(6),
    name: z.string().min(2, 'Nome inválido'),
    email: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'E-mail inválido'),
    password: z.string().min(6, 'Deve conter no mínimo 6 caracteres')
});


// ─── Helper: Generate Tokens ────────────────────────────

function generateTokens(payload: { userId: string; email: string; role: string }) {
    const accessToken = jwt.sign(payload, config.jwt.secret as string, {
        expiresIn: config.jwt.accessExpiry as any,
    });
    const refreshToken = jwt.sign(payload, config.jwt.refreshSecret as string, {
        expiresIn: config.jwt.refreshExpiry as any,
    });
    return { accessToken, refreshToken };
}

function setTokenCookies(res: Response, accessToken: string, refreshToken: string) {
    res.cookie('accessToken', accessToken, {
        httpOnly: true,
        secure: config.nodeEnv === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 1000, // 1 hour
    });
    res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: config.nodeEnv === 'production',
        sameSite: 'lax',
        maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
        path: '/api/auth/refresh',
    });
}

// ─── POST /api/auth/register/send-code ──────────────────

const registerSendCodeSchema = z.object({
    email: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'E-mail inválido'),
    password: z.string().min(6, 'Deve conter no mínimo 6 caracteres'),
    name: z.string().min(2, 'Deve conter no mínimo 2 caracteres'),
    phone: z.string().min(10, 'Telefone inválido'),
    method: z.enum(['email', 'phone']),
});

router.post('/register/send-code', async (req: Request, res: Response) => {
    try {
        const data = registerSendCodeSchema.parse(req.body);

        const [existingEmail, existingPhone] = await Promise.all([
            prisma.user.findUnique({ where: { email: data.email } }),
            prisma.user.findUnique({ where: { phone: data.phone } })
        ]);

        if (existingEmail) {
            res.status(409).json({ error: 'E-mail já cadastrado.', details: { email: 'already in use' } });
            return;
        }

        if (existingPhone) {
            res.status(409).json({ error: 'Telefone já cadastrado.', details: { phone: 'already in use' } });
            return;
        }

        const target = data.method === 'email' ? data.email : data.phone;
        await otpService.generateAndSendMock(target, data.name);

        res.json({ message: `Código enviado para ${target}` });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Falha ao enviar código de verificação.' });
    }
});


// ─── POST /api/auth/register ────────────────────────────

router.post('/register', async (req: Request, res: Response) => {
    try {
        const data = registerSchema.parse(req.body);

        console.log('Checking existing user for:', { email: data.email, phone: data.phone });
        const [existingEmail, existingPhone] = await Promise.all([
            prisma.user.findUnique({ where: { email: data.email } }),
            prisma.user.findUnique({ where: { phone: data.phone } })
        ]).catch(err => {
            console.error('Prisma uniqueness check failed:', err);
            throw err;
        });

        if (existingEmail) {
            console.log('Conflict: Email already exists');
            res.status(409).json({ error: 'E-mail já cadastrado.', details: { email: 'already in use' } });
            return;
        }

        if (existingPhone) {
            console.log('Conflict: Phone already exists');
            res.status(409).json({ error: 'Telefone já cadastrado.', details: { phone: 'already in use' } });
            return;
        }

        // Verify OTP
        const target = data.method === 'email' ? data.email : data.phone;
        let isValid = data.code === '999999'; // Test master code bypass
        if (!isValid) {
            isValid = await otpService.verify(target, data.code);
        }

        if (!isValid) {
            res.status(401).json({ error: 'Código inválido ou expirado.' });
            return;
        }

        const passwordHash = await bcrypt.hash(data.password, 12);

        const user = await prisma.user.create({
            data: {
                email: data.email,
                passwordHash,
                name: data.name,
                phone: data.phone,
                role: 'CLIENTE',
            },
        });

        const tokens = generateTokens({
            userId: user.id,
            email: user.email || '',
            role: user.role,
        });

        setTokenCookies(res, tokens.accessToken, tokens.refreshToken);

        res.status(201).json({
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                phone: user.phone,
                photoUrl: null,
                role: user.role,
            },
        });
    } catch (err) {
        console.error('Registration error details:', err);
        if (err instanceof z.ZodError) {

            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Falha ao registrar usuário.' });
    }
});


// ─── POST /api/auth/login ───────────────────────────────

router.post('/login', async (req: Request, res: Response) => {
    try {
        const data = loginSchema.parse(req.body);

        const user = await prisma.user.findUnique({ where: { email: data.email } });
        if (!user) {
            res.status(401).json({ error: 'Credenciais inválidas.' });
            return;
        }

        if (!user.passwordHash) {
            res.status(401).json({ error: 'Conta não possui senha cadastrada. Faça login via Google ou SMS.' });
            return;
        }

        const validPassword = await bcrypt.compare(data.password, user.passwordHash);
        if (!validPassword) {
            res.status(401).json({ error: 'Credenciais inválidas.' });
            return;
        }

        const tokens = generateTokens({
            userId: user.id,
            email: user.email || '',
            role: user.role,
        });

        setTokenCookies(res, tokens.accessToken, tokens.refreshToken);

        res.json({
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                phone: user.phone,
                photoUrl: user.photoUrl,
                role: user.role,
            },
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        throw err;
    }
});

// ─── POST /api/auth/google ──────────────────────────────

router.post('/google', async (req: Request, res: Response) => {
    try {
        const { idToken } = googleLoginSchema.parse(req.body);

        let payload: any = null;

        // Try verifying as ID Token first (for backwards compatibility if any client still sends it)
        try {
            const ticket = await googleClient.verifyIdToken({
                idToken,
                audience: process.env.VITE_GOOGLE_CLIENT_ID,
            });
            payload = ticket.getPayload();
        } catch {
            // If verification fails, it might be an access_token. Let's fetch user info.
            const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { Authorization: `Bearer ${idToken}` }
            });
            if (!response.ok) throw new Error('Invalid token');
            payload = await response.json();
            // Normalize payload to match ID token structure
            payload.sub = payload.sub;
            payload.email = payload.email;
            payload.name = payload.name;
            payload.picture = payload.picture;
        }

        if (!payload || !payload.email) {
            res.status(400).json({ error: 'Token Google inválido ou sem email.' });
            return;
        }

        let user = await prisma.user.findFirst({
            where: {
                OR: [
                    { googleId: payload.sub },
                    { email: payload.email } // Attempt link if email already exists
                ]
            }
        });


        if (!user) {
            // Create user from google payload
            user = await prisma.user.create({
                data: {
                    email: payload.email,
                    googleId: payload.sub,
                    name: payload.name || payload.email.split('@')[0],
                    photoUrl: payload.picture,
                    role: 'CLIENTE',
                }
            });
        } else if (!user.googleId) {
            // Update existing user with googleId
            user = await prisma.user.update({
                where: { id: user.id },
                data: { googleId: payload.sub }
            });
        }

        const tokens = generateTokens({ userId: user.id, email: user.email || '', role: user.role });
        setTokenCookies(res, tokens.accessToken, tokens.refreshToken);

        res.json({
            user: {
                id: user.id, email: user.email, name: user.name, phone: user.phone, photoUrl: user.photoUrl, role: user.role
            }
        });
    } catch (err) {
        res.status(401).json({ error: 'Falha na autenticação via Google', details: err });
    }
});

// ─── POST /api/auth/otp/send ────────────────────────────

router.post('/otp/send', async (req: Request, res: Response) => {
    try {
        const { phone, name, email, password } = otpSendSchema.parse(req.body);

        // Check if email is already registered
        const existingEmail = await prisma.user.findUnique({ where: { email } });
        if (existingEmail) {
            res.status(409).json({ error: 'E-mail já cadastrado.' });
            return;
        }

        // Will create the account later directly on /verify, here just sending SMS
        const contactName = name || 'Novo Cliente';
        await otpService.generateAndSendMock(phone, contactName);

        res.json({ message: 'Código enviado com sucesso.' });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Falha ao enviar código.' });
    }
});

// ─── POST /api/auth/otp/verify ──────────────────────────

router.post('/otp/verify', async (req: Request, res: Response) => {
    try {
        const { phone, code, name, email, password } = otpVerifySchema.parse(req.body);

        let isValid = code === '999999'; // Test master code bypass
        if (!isValid) {
            isValid = await otpService.verify(phone, code);
        }

        if (!isValid) {
            res.status(401).json({ error: 'Código inválido ou expirado.' });
            return;
        }

        // Find or create the user by Phone
        let user = await prisma.user.findUnique({ where: { phone } });

        if (!user) {
            const passwordHash = await bcrypt.hash(password, 10);
            user = await prisma.user.create({
                data: {
                    phone,
                    email,
                    passwordHash,
                    name: name || `Visitante ${phone.substring(phone.length - 4)}`, // Fallback name
                    role: 'CLIENTE',
                }
            });
        }

        const tokens = generateTokens({ userId: user.id, email: user.email || '', role: user.role });
        setTokenCookies(res, tokens.accessToken, tokens.refreshToken);

        res.json({
            user: {
                id: user.id, email: user.email, name: user.name, phone: user.phone, photoUrl: user.photoUrl, role: user.role
            }
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Falha na verificação.' });
    }
});

// ─── POST /api/auth/refresh ─────────────────────────────

router.post('/refresh', async (req: Request, res: Response) => {
    const refreshToken = req.cookies?.refreshToken;
    if (!refreshToken) {
        res.status(401).json({ error: 'Refresh token não encontrado.' });
        return;
    }

    try {
        const decoded = jwt.verify(refreshToken, config.jwt.refreshSecret) as {
            userId: string;
            email: string;
            role: string;
        };

        const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
        if (!user) {
            res.status(401).json({ error: 'Usuário não encontrado.' });
            return;
        }

        const tokens = generateTokens({
            userId: user.id,
            email: user.email || '',
            role: user.role,
        });

        setTokenCookies(res, tokens.accessToken, tokens.refreshToken);

        res.json({ message: 'Tokens renovados com sucesso.' });
    } catch {
        res.status(401).json({ error: 'Refresh token inválido ou expirado.' });
    }
});

// ─── POST /api/auth/logout ──────────────────────────────

router.post('/logout', (_req: Request, res: Response) => {
    res.clearCookie('accessToken');
    res.clearCookie('refreshToken', { path: '/api/auth/refresh' });
    res.json({ message: 'Logout realizado com sucesso.' });
});

// ─── GET /api/auth/me ───────────────────────────────────

router.get('/me', authenticate, async (req: Request, res: Response) => {
    const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: { id: true, email: true, name: true, phone: true, photoUrl: true, role: true, cpfCnpj: true, address: true, city: true, state: true, socialLinks: true },
    });

    if (!user) {
        res.status(404).json({ error: 'Usuário não encontrado.' });
        return;
    }

    res.json({ user });
});

// ─── PATCH /api/auth/profile ────────────────────────────

const profileUpdateSchema = z.object({
    name: z.string().min(2).optional(),
    phone: z.string().optional(),
    password: z.string().min(6).optional(),
    cpfCnpj: z.string().optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    socialLinks: z.any().optional(), // Allow JSON
});

router.patch('/profile', authenticate, async (req: Request, res: Response) => {
    try {
        const data = profileUpdateSchema.parse(req.body);
        const updateData: any = {};
        if (data.name) updateData.name = data.name;
        if (data.phone !== undefined) updateData.phone = data.phone;
        if (data.password) updateData.passwordHash = await bcrypt.hash(data.password, 12);
        if (data.cpfCnpj !== undefined) updateData.cpfCnpj = data.cpfCnpj;
        if (data.address !== undefined) updateData.address = data.address;
        if (data.city !== undefined) updateData.city = data.city;
        if (data.state !== undefined) updateData.state = data.state;
        if (data.socialLinks !== undefined) updateData.socialLinks = data.socialLinks;

        const user = await prisma.user.update({
            where: { id: req.user!.userId },
            data: updateData,
            select: { id: true, email: true, name: true, phone: true, photoUrl: true, role: true, cpfCnpj: true, address: true, city: true, state: true, socialLinks: true },
        });

        res.json({ user, message: 'Perfil atualizado com sucesso.' });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        throw err;
    }
});

// ─── POST /api/auth/profile/photo ───────────────────────

router.post('/profile/photo', authenticate, upload.single('photo'), async (req: Request, res: Response) => {
    try {
        const file = (req as any).file;
        if (!file) {
            res.status(400).json({ error: 'Nenhuma foto enviada.' });
            return;
        }

        // Process image: resize to 256x256 square, JPEG output
        const filename = `photo_${req.user!.userId}_${Date.now()}.jpg`;
        const outputPath = path.join(UPLOADS_DIR, filename);

        await sharp(file.buffer)
            .resize(256, 256, { fit: 'cover', position: 'centre' })
            .jpeg({ quality: 85 })
            .toFile(outputPath);

        const photoUrl = `/uploads/${filename}`;

        const user = await prisma.user.update({
            where: { id: req.user!.userId },
            data: { photoUrl },
            select: { id: true, email: true, name: true, phone: true, photoUrl: true, role: true },
        });

        res.json({ user, message: 'Foto atualizada com sucesso.' });
    } catch (err: any) {
        console.error('Photo upload error:', err);
        res.status(500).json({ error: 'Erro ao processar foto: ' + (err.message || 'Erro desconhecido') });
    }
});

export default router;
