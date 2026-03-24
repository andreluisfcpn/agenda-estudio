import { Request, Response, NextFunction } from 'express';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
    console.error('Unhandled error:', err);

    if (err.name === 'ZodError') {
        res.status(400).json({
            error: 'Dados inválidos.',
            details: JSON.parse(err.message),
        });
        return;
    }

    res.status(500).json({
        error: 'Erro interno do servidor.',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    });
}
