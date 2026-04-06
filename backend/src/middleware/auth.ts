import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { Role } from '../generated/prisma/client';

// Extend Express Request type to include user info
declare global {
    namespace Express {
        interface Request {
            user?: {
                userId: string;
                email: string;
                role: Role;
            };
        }
    }
}

interface JwtPayload {
    userId: string;
    email: string;
    role: Role;
}

/**
 * Authenticate middleware: validates JWT from HttpOnly cookie.
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
    const token = req.cookies?.accessToken;

    if (!token) {
        res.status(401).json({ error: 'Autenticação necessária. Faça login.' });
        return;
    }

    try {
        const decoded = jwt.verify(token, config.jwt.secret) as JwtPayload;
        req.user = {
            userId: decoded.userId,
            email: decoded.email,
            role: decoded.role,
        };
        next();
    } catch (err) {
        res.status(401).json({ error: 'Token inválido ou expirado.' });
        return;
    }
}

/**
 * Authorization middleware: checks if user has one of the allowed roles.
 */
export function authorize(...allowedRoles: Role[]) {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (!req.user) {
            res.status(401).json({ error: 'Autenticação necessária.' });
            return;
        }

        if (!allowedRoles.includes(req.user.role)) {
            res.status(403).json({ error: 'Acesso negado. Permissão insuficiente.' });
            return;
        }

        next();
    };
}
