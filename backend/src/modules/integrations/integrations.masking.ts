// ─── Integration credential masking helpers ─────────────
// Pure functions to mask sensitive fields for GET responses

export function maskCoraCredentials(creds: Record<string, any>): Record<string, any> {
    const masked = { ...creds };
    if (masked.clientId) masked.clientId = maskString(masked.clientId);
    if (masked.certificatePem) masked.certificatePem = '***CERTIFICATE_CONFIGURED***';
    if (masked.privateKeyPem) masked.privateKeyPem = '***PRIVATE_KEY_CONFIGURED***';
    return masked;
}

export function maskStripeCredentials(creds: Record<string, any>): Record<string, any> {
    const masked = { ...creds };
    if (masked.secretKey) masked.secretKey = maskString(masked.secretKey);
    if (masked.webhookSecret) masked.webhookSecret = maskString(masked.webhookSecret);
    // publishableKey is safe to show (it's public)
    return masked;
}

export function maskConfig(provider: string, config: Record<string, any>): Record<string, any> {
    const masked = { ...config };

    if (provider === 'CORA') {
        // Dual format: { sandbox: {...}, production: {...} }
        if (masked.sandbox && typeof masked.sandbox === 'object') {
            masked.sandbox = maskCoraCredentials(masked.sandbox);
        }
        if (masked.production && typeof masked.production === 'object') {
            masked.production = maskCoraCredentials(masked.production);
        }
        // Legacy flat format (backward-compat)
        if (masked.clientId) masked.clientId = maskString(masked.clientId);
        if (masked.certificatePem) masked.certificatePem = '***CERTIFICATE_CONFIGURED***';
        if (masked.privateKeyPem) masked.privateKeyPem = '***PRIVATE_KEY_CONFIGURED***';
    }

    if (provider === 'STRIPE') {
        // Dual format: { sandbox: {...}, production: {...} }
        if (masked.sandbox && typeof masked.sandbox === 'object') {
            masked.sandbox = maskStripeCredentials(masked.sandbox);
        }
        if (masked.production && typeof masked.production === 'object') {
            masked.production = maskStripeCredentials(masked.production);
        }
        // Legacy flat format (backward-compat)
        if (masked.secretKey) masked.secretKey = maskString(masked.secretKey);
        if (masked.webhookSecret) masked.webhookSecret = maskString(masked.webhookSecret);
    }

    return masked;
}

export function maskString(value: string): string {
    if (value.length <= 8) return '***';
    return value.slice(0, 7) + '...' + value.slice(-4);
}
