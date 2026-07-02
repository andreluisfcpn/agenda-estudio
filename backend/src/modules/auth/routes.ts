import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import multer from 'multer';
import sharp from 'sharp';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config/index.js';
import { authenticate } from '../../middleware/auth.js';
import { OAuth2Client } from 'google-auth-library';
import { otpService } from '../../lib/otp.js';
import { Prisma } from '../../generated/prisma/client.js';
import { isValidCpfCnpj } from '../../utils/document.js';
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

// ─── Validation Schemas ─────────────────────────────────

const registerSchema = z.object({
    email: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'E-mail inválido'),
    password: z.string().min(6, 'Deve conter no mínimo 6 caracteres'),
    name: z.string().min(2, 'Deve conter no mínimo 2 caracteres'),
    code: z.string().min(6, 'Código inválido').max(6),
});


const loginSchema = z.object({
    email: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'E-mail inválido'),
    password: z.string().min(1, 'Senha obrigatória'),
});

const googleLoginSchema = z.object({
    idToken: z.string().min(1)
});

// Passwordless e-mail login (OTP): request a code, then verify it.
const loginSendCodeSchema = z.object({
    email: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'E-mail inválido'),
});

const loginVerifyCodeSchema = z.object({
    email: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'E-mail inválido'),
    code: z.string().min(6, 'Código inválido').max(6),
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
    // sameSite is intentionally 'lax' (not 'strict'): 'strict' would drop the auth cookies on the
    // top-level redirect back from Google OAuth and on any external deep-link into the PWA (push/
    // email notification links), breaking those flows. 'lax' still blocks CSRF on unsafe methods.
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

// ─── Helper: client-facing user shape ────────────────────
// MUST match GET /me and PATCH /profile. Every auth response returns this full
// shape because the frontend does updateUser(res.user) — a partial object here
// would WIPE fields (e.g. cpfCnpj) from the AuthContext, making the contract
// wizards re-ask for data the user already saved.
interface AuthUserRecord {
    id: string; email: string | null; name: string; phone: string | null;
    photoUrl: string | null; role: string; cpfCnpj: string | null;
    address: string | null; city: string | null; state: string | null;
    socialLinks: string | null; essentialNotificationsOnly: boolean;
}

function toAuthUser(u: AuthUserRecord) {
    return {
        id: u.id, email: u.email, name: u.name, phone: u.phone, photoUrl: u.photoUrl, role: u.role,
        cpfCnpj: u.cpfCnpj, address: u.address, city: u.city, state: u.state,
        socialLinks: u.socialLinks, essentialNotificationsOnly: u.essentialNotificationsOnly,
    };
}

// ─── POST /api/auth/register/send-code ──────────────────

const registerSendCodeSchema = z.object({
    email: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'E-mail inválido'),
    password: z.string().min(6, 'Deve conter no mínimo 6 caracteres'),
    name: z.string().min(2, 'Deve conter no mínimo 2 caracteres'),
});

router.post('/register/send-code', async (req: Request, res: Response) => {
    try {
        const data = registerSendCodeSchema.parse(req.body);
        data.email = data.email.trim().toLowerCase();

        const existingEmail = await prisma.user.findUnique({ where: { email: data.email } });
        if (existingEmail) {
            res.status(409).json({ error: 'E-mail já cadastrado.', details: { email: 'already in use' } });
            return;
        }

        // Anti-spam: enforce a short per-target resend cooldown
        if (await otpService.isOnSendCooldown(data.email)) {
            res.status(429).json({ error: 'Aguarde alguns segundos antes de solicitar um novo código.' });
            return;
        }

        await otpService.generateAndSend(data.email, data.name);

        res.json({ message: `Código enviado para ${data.email}` });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        // Don't leak raw provider errors (SMTP host/port, Resend status) to anonymous callers.
        console.error('[AUTH] register/send-code error:', err);
        res.status(500).json({ error: 'Não foi possível enviar o código agora. Tente novamente em instantes.' });
    }
});


// ─── POST /api/auth/register ────────────────────────────

router.post('/register', async (req: Request, res: Response) => {
    try {
        const data = registerSchema.parse(req.body);
        data.email = data.email.trim().toLowerCase();

        const existingEmail = await prisma.user.findUnique({ where: { email: data.email } });
        if (existingEmail) {
            res.status(409).json({ error: 'E-mail já cadastrado.', details: { email: 'already in use' } });
            return;
        }

        // Verify OTP (VULN-05 fix: require explicit flag instead of trusting NODE_ENV)
        // PAY-08 FIX: Double-check NODE_ENV — bypass NEVER works in production
        const canBypass = process.env.ALLOW_OTP_BYPASS === 'true' && process.env.NODE_ENV !== 'production';
        let isValid = canBypass && data.code === '999999';
        if (!isValid) {
            isValid = await otpService.verify(data.email, data.code);
        }
        if (isValid && canBypass && data.code === '999999') {
            console.warn(`[AUTH] OTP bypass used for ${data.email} (dev mode)`);
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
                role: 'CLIENTE',
            },
        });

        const tokens = generateTokens({
            userId: user.id,
            email: user.email || '',
            role: user.role,
        });

        setTokenCookies(res, tokens.accessToken, tokens.refreshToken);

        res.status(201).json({ user: toAuthUser(user) });
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
        data.email = data.email.trim().toLowerCase();

        const user = await prisma.user.findUnique({ where: { email: data.email } });
        if (!user) {
            res.status(401).json({ error: 'Credenciais inválidas.' });
            return;
        }

        if (!user.passwordHash) {
            res.status(401).json({ error: 'Conta não possui senha cadastrada. Faça login via Google ou código por e-mail.' });
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

        res.json({ user: toAuthUser(user) });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        throw err;
    }
});

// ─── POST /api/auth/login/send-code ─────────────────────
// Passwordless login: e-mail a 6-digit code. Existing accounts only.

router.post('/login/send-code', async (req: Request, res: Response) => {
    try {
        const { email: rawEmail } = loginSendCodeSchema.parse(req.body);
        const email = rawEmail.trim().toLowerCase();

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
            res.status(404).json({ error: 'Conta não encontrada.' });
            return;
        }

        // Anti-spam: enforce a short per-target resend cooldown
        if (await otpService.isOnSendCooldown(email)) {
            res.status(429).json({ error: 'Aguarde alguns segundos antes de solicitar um novo código.' });
            return;
        }

        await otpService.generateAndSend(email, user.name);

        res.json({ message: 'Código enviado para seu e-mail.' });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        // Don't leak raw provider errors to anonymous callers.
        console.error('[AUTH] login/send-code error:', err);
        res.status(500).json({ error: 'Não foi possível enviar o código agora. Tente novamente em instantes.' });
    }
});

// ─── POST /api/auth/login/verify-code ───────────────────

router.post('/login/verify-code', async (req: Request, res: Response) => {
    try {
        const { email: rawEmail, code } = loginVerifyCodeSchema.parse(req.body);
        const email = rawEmail.trim().toLowerCase();

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
            res.status(404).json({ error: 'Conta não encontrada.' });
            return;
        }

        const canBypass = process.env.ALLOW_OTP_BYPASS === 'true' && process.env.NODE_ENV !== 'production';
        let isValid = canBypass && code === '999999';
        if (!isValid) {
            isValid = await otpService.verify(email, code);
        }
        if (isValid && canBypass && code === '999999') {
            console.warn(`[AUTH] OTP login bypass used for ${email} (dev mode)`);
        }

        if (!isValid) {
            res.status(401).json({ error: 'Código inválido ou expirado.' });
            return;
        }

        const tokens = generateTokens({ userId: user.id, email: user.email || '', role: user.role });
        setTokenCookies(res, tokens.accessToken, tokens.refreshToken);

        res.json({ user: toAuthUser(user) });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        console.error('[AUTH] login/verify-code error:', err);
        res.status(500).json({ error: 'Falha ao validar o código.' });
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
        payload.email = String(payload.email).trim().toLowerCase();

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

        res.json({ user: toAuthUser(user) });
    } catch (err) {
        // AUTH-M3 FIX: Don't expose internal error object to client
        console.error('[AUTH:Google] Authentication error:', err);
        res.status(401).json({ error: 'Falha na autenticação via Google.' });
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
        select: { id: true, email: true, name: true, phone: true, photoUrl: true, role: true, cpfCnpj: true, address: true, city: true, state: true, socialLinks: true, essentialNotificationsOnly: true },
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
    essentialNotificationsOnly: z.boolean().optional(),
});

router.patch('/profile', authenticate, async (req: Request, res: Response) => {
    try {
        const data = profileUpdateSchema.parse(req.body);
        const updateData: Prisma.UserUncheckedUpdateInput = {};
        if (data.name) updateData.name = data.name;
        if (data.phone !== undefined) updateData.phone = data.phone;
        if (data.password) updateData.passwordHash = await bcrypt.hash(data.password, 12);
        if (data.cpfCnpj !== undefined) {
            const digits = data.cpfCnpj.replace(/\D/g, '');
            if (digits && !isValidCpfCnpj(digits)) {
                res.status(400).json({ error: 'CPF/CNPJ inválido. Confira os números.' });
                return;
            }
            updateData.cpfCnpj = digits || null;
        }
        if (data.address !== undefined) updateData.address = data.address;
        if (data.city !== undefined) updateData.city = data.city;
        if (data.state !== undefined) updateData.state = data.state;
        if (data.socialLinks !== undefined) updateData.socialLinks = JSON.stringify(data.socialLinks);
        if (data.essentialNotificationsOnly !== undefined) updateData.essentialNotificationsOnly = data.essentialNotificationsOnly;

        const user = await prisma.user.update({
            where: { id: req.user!.userId },
            data: updateData,
            select: { id: true, email: true, name: true, phone: true, photoUrl: true, role: true, cpfCnpj: true, address: true, city: true, state: true, socialLinks: true, essentialNotificationsOnly: true },
        });

        res.json({ user, message: 'Perfil atualizado com sucesso.' });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        // Unique constraint (cpfCnpj already used by another account)
        if (err && typeof err === 'object' && (err as { code?: string }).code === 'P2002') {
            res.status(409).json({ error: 'Este CPF/CNPJ já está cadastrado em outra conta.' });
            return;
        }
        throw err;
    }
});

// ─── POST /api/auth/profile/photo ───────────────────────

// Multer errors (file too large, unexpected field, filter rejection) surface in
// English by default. Wrap the middleware so the client always gets pt-BR.
const photoUploadMw = (req: Request, res: Response, next: (err?: unknown) => void) => {
    upload.single('photo')(req, res, (err: unknown) => {
        if (!err) return next();
        console.error('[PHOTO] multer error:', err);
        const code = (err as { code?: string }).code;
        if (code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({ error: 'Imagem muito grande (máx. 10MB).' });
            return;
        }
        const msg = getErrorMessage(err);
        res.status(400).json({ error: msg === 'Apenas imagens são permitidas.' ? msg : 'Não foi possível receber a imagem. Tente novamente.' });
    });
};

router.post('/profile/photo', authenticate, photoUploadMw, async (req: Request, res: Response) => {
    try {
        const file = req.file;
        if (!file) {
            res.status(400).json({ error: 'Nenhuma foto enviada.' });
            return;
        }

        // Process image: resize to 256x256 square JPEG and store it as a data-URL in
        // the DB. Railway's filesystem is ephemeral — files under /uploads vanish on
        // every redeploy, which used to leave avatars 404 (empty gradient circle).
        // At 256px/q80 the data-URL is ~15-25KB, fine for a text column.
        const buffer = await sharp(file.buffer)
            .resize(256, 256, { fit: 'cover', position: 'centre' })
            .jpeg({ quality: 80 })
            .toBuffer();
        const photoUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;

        const user = await prisma.user.update({
            where: { id: req.user!.userId },
            data: { photoUrl },
        });

        res.json({ user: toAuthUser(user), message: 'Foto atualizada com sucesso.' });
    } catch (err: unknown) {
        // Sharp/Prisma details stay in the server log — the client gets pt-BR.
        console.error('Photo upload error:', err);
        res.status(500).json({ error: 'Não foi possível processar a imagem. Tente novamente.' });
    }
});

export default router;
