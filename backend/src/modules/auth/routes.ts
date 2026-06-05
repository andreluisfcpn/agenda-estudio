import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import sharp from 'sharp';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config/index.js';
import { authenticate } from '../../middleware/auth.js';
import { OAuth2Client } from 'google-auth-library';
import { otpService } from '../../lib/otp.js';
import { Prisma } from '../../generated/prisma/client.js';
import { getErrorMessage } from '../../utils/errors.js';

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID);


const router = Router();

// ─── Multer for photo uploads (memory storage) ──────────
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB raw
    fileFilter: (_req, file, cb) => {
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
        expiresIn: config.jwt.accessExpiry as any, // string literal e.g. '15m'
    });
    const refreshToken = jwt.sign(payload, config.jwt.refreshSecret as string, {
        expiresIn: config.jwt.refreshExpiry as any, // string literal e.g. '7d'
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
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days (VULN-06 fix: was 365 days)
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

        // Anti-spam: enforce a short per-target resend cooldown
        if (await otpService.isOnSendCooldown(target)) {
            res.status(429).json({ error: 'Aguarde alguns segundos antes de solicitar um novo código.' });
            return;
        }

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

        // Verify OTP (VULN-05 fix: require explicit flag instead of trusting NODE_ENV)
        // PAY-08 FIX: Double-check NODE_ENV — bypass NEVER works in production
        const target = data.method === 'email' ? data.email : data.phone;
        const canBypass = process.env.ALLOW_OTP_BYPASS === 'true' && process.env.NODE_ENV !== 'production';
        let isValid = canBypass && data.code === '999999';
        if (!isValid) {
            isValid = await otpService.verify(target, data.code);
        }
        if (isValid && canBypass && data.code === '999999') {
            console.warn(`[AUTH] OTP bypass used for ${target} (dev mode)`);
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

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Google payload shape varies between ID token and userinfo endpoint
        let payload: Record<string, any> | null = null;

        const expectedClientId = process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID;

        // Try verifying as ID Token first (validates signature + audience for us)
        try {
            const ticket = await googleClient.verifyIdToken({
                idToken,
                audience: expectedClientId,
            });
            payload = ticket.getPayload() ?? null;
        } catch {
            // Not an ID token → treat as an OAuth access_token. We MUST validate that the
            // token was issued for THIS app (audience) before trusting it, otherwise ANY
            // Google access_token obtained by any third-party app could be replayed here
            // to impersonate the victim (account takeover). The /userinfo endpoint happily
            // returns a profile for ANY valid Google access_token regardless of client.
            if (!expectedClientId) {
                res.status(500).json({ error: 'Login Google não está configurado no servidor.' });
                return;
            }

            const tokenInfoRes = await fetch(
                `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(idToken)}`
            );
            if (!tokenInfoRes.ok) {
                res.status(401).json({ error: 'Token Google inválido.' });
                return;
            }
            const tokenInfo = await tokenInfoRes.json() as Record<string, any>;
            const tokenAudience = tokenInfo.aud || tokenInfo.azp || tokenInfo.issued_to;
            if (tokenAudience !== expectedClientId) {
                console.error(`[Auth:Google] access_token audience mismatch (${tokenAudience} != ${expectedClientId}) — rejecting`);
                res.status(401).json({ error: 'Token Google não autorizado para este aplicativo.' });
                return;
            }

            // Audience validated — now it's safe to fetch the profile
            const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { Authorization: `Bearer ${idToken}` }
            });
            if (!response.ok) throw new Error('Invalid token');
            payload = await response.json() as Record<string, any>;
        }

        if (!payload || !payload.email) {
            res.status(400).json({ error: 'Token Google inválido ou sem email.' });
            return;
        }

        // AUTH-H1 FIX: First try to find by googleId (safe — unique identifier)
        let user = await prisma.user.findFirst({
            where: { googleId: payload.sub },
        });

        if (!user) {
            // Check if email is already registered (potential account linking)
            const existingByEmail = await prisma.user.findFirst({
                where: { email: payload.email },
            });

            if (existingByEmail) {
                // AUTH-H1 FIX: Don't auto-link — require user to login with password first
                // This prevents account takeover via email-based Google OAuth linking
                if (existingByEmail.passwordHash) {
                    res.status(409).json({
                        error: 'Já existe uma conta com este e-mail. Faça login com sua senha e vincule o Google nas configurações.',
                        requiresPasswordAuth: true,
                    });
                    return;
                }
                // If no password (created via OTP only), safe to link since both are external auth
                user = await prisma.user.update({
                    where: { id: existingByEmail.id },
                    data: { googleId: payload.sub },
                });
            } else {
                // Create new user from Google payload
                user = await prisma.user.create({
                    data: {
                        email: payload.email,
                        googleId: payload.sub,
                        name: payload.name || payload.email.split('@')[0],
                        photoUrl: payload.picture,
                        role: 'CLIENTE',
                    },
                });
            }
        }

        const tokens = generateTokens({ userId: user.id, email: user.email || '', role: user.role });
        setTokenCookies(res, tokens.accessToken, tokens.refreshToken);

        res.json({
            user: {
                id: user.id, email: user.email, name: user.name, phone: user.phone, photoUrl: user.photoUrl, role: user.role
            }
        });
    } catch (err) {
        // AUTH-M3 FIX: Don't expose internal error object to client
        console.error('[AUTH:Google] Authentication error:', err);
        res.status(401).json({ error: 'Falha na autenticação via Google.' });
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

        // Anti-spam: enforce a short per-target resend cooldown
        if (await otpService.isOnSendCooldown(phone)) {
            res.status(429).json({ error: 'Aguarde alguns segundos antes de solicitar um novo código.' });
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

        // VULN-05 fix: require explicit flag for OTP bypass
        // PAY-08 FIX: Double-check NODE_ENV — bypass NEVER works in production
        const canBypass = process.env.ALLOW_OTP_BYPASS === 'true' && process.env.NODE_ENV !== 'production';
        let isValid = canBypass && code === '999999';
        if (!isValid) {
            isValid = await otpService.verify(phone, code);
        }
        if (isValid && canBypass && code === '999999') {
            console.warn(`[AUTH] OTP bypass used for ${phone} (dev mode)`);
        }

        if (!isValid) {
            res.status(401).json({ error: 'Código inválido ou expirado.' });
            return;
        }

        // Find or create the user by Phone
        let user = await prisma.user.findUnique({ where: { phone } });

        if (!user) {
            const passwordHash = await bcrypt.hash(password, 12); // AUTH-H2 FIX: standardize cost to 12
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
        const decoded = jwt.verify(refreshToken, config.jwt.refreshSecret, { algorithms: ['HS256'] }) as {
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
    socialLinks: z.union([
        z.string().max(500),
        z.object({
            instagram: z.string().max(100).optional(),
            linkedin: z.string().max(200).optional(),
            youtube: z.string().max(200).optional(),
            tiktok: z.string().max(200).optional(),
            twitter: z.string().max(200).optional(),
        }),
    ]).optional(),
});

router.patch('/profile', authenticate, async (req: Request, res: Response) => {
    try {
        const data = profileUpdateSchema.parse(req.body);
        const updateData: Prisma.UserUncheckedUpdateInput = {};
        if (data.name) updateData.name = data.name;
        if (data.phone !== undefined) updateData.phone = data.phone;
        if (data.password) updateData.passwordHash = await bcrypt.hash(data.password, 12);
        if (data.cpfCnpj !== undefined) updateData.cpfCnpj = data.cpfCnpj;
        if (data.address !== undefined) updateData.address = data.address;
        if (data.city !== undefined) updateData.city = data.city;
        if (data.state !== undefined) updateData.state = data.state;
        if (data.socialLinks !== undefined) updateData.socialLinks = JSON.stringify(data.socialLinks);

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
        const file = req.file;
        if (!file) {
            res.status(400).json({ error: 'Nenhuma foto enviada.' });
            return;
        }

        // Process image: resize to 256x256 square, JPEG output
        // AUTH-H3 FIX: Sanitize userId to prevent theoretical path traversal
        const safeUserId = req.user!.userId.replace(/[^a-zA-Z0-9\-_]/g, '');
        const filename = `photo_${safeUserId}_${Date.now()}.jpg`;
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
    } catch (err: unknown) {
        console.error('Photo upload error:', err);
        res.status(500).json({ error: 'Erro ao processar foto: ' + getErrorMessage(err) });
    }
});

export default router;
