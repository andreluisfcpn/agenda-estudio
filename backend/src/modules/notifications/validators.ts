import { z } from 'zod';

// Template override: every field optional; null clears an override back to the catalog default.
export const templateUpdateSchema = z.object({
    enabled: z.boolean().optional(),
    title: z.string().trim().min(1).max(120).nullable().optional(),
    message: z.string().trim().min(1).max(1000).nullable().optional(),
    severity: z.enum(['critical', 'warning', 'info']).nullable().optional(),
    pushEnabled: z.boolean().nullable().optional(),
});
export type TemplateUpdateInput = z.infer<typeof templateUpdateSchema>;

export const broadcastSchema = z.object({
    title: z.string().trim().min(3).max(120),
    message: z.string().trim().min(3).max(1000),
    severity: z.enum(['critical', 'warning', 'info']).default('info'),
    target: z.union([z.literal('all'), z.array(z.string().uuid()).min(1).max(500)]),
    sendPush: z.boolean().default(true),
});
export type BroadcastInput = z.infer<typeof broadcastSchema>;
