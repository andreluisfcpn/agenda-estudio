import { prisma } from './prisma.js';

export async function logAudit(
    entityType: string,
    entityId: string,
    action: string,
    performedBy: string,
    changes?: Record<string, any>
): Promise<void> {
    try {
        await prisma.auditLog.create({
            data: {
                entityType,
                entityId,
                action,
                performedBy,
                changes: changes ? JSON.stringify(changes) : null,
            },
        });
    } catch (err) {
        console.error('[AuditLog] Failed to log:', err);
    }
}
