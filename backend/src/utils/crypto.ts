// ─── Credential Encryption Utility ──────────────────────
// Encrypts/decrypts integration credentials at the application layer
// using AES-256-GCM before storing in the database.

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
    const secret = process.env.JWT_SECRET || '';
    // Derive a 32-byte key from the JWT secret using SHA-256
    return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt a plaintext string.
 * Output format: base64(iv + authTag + ciphertext)
 */
export function encryptCredentials(plaintext: string): string {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    // Pack: IV (16) + AuthTag (16) + Ciphertext
    const packed = Buffer.concat([iv, authTag, encrypted]);
    return packed.toString('base64');
}

/**
 * Decrypt a previously encrypted string.
 * Input format: base64(iv + authTag + ciphertext)
 */
export function decryptCredentials(encryptedBase64: string): string {
    const key = getEncryptionKey();
    const packed = Buffer.from(encryptedBase64, 'base64');

    const iv = packed.subarray(0, IV_LENGTH);
    const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ]);

    return decrypted.toString('utf8');
}

/**
 * Check if a string looks like it's already encrypted (base64 with enough length).
 * Used for backward compatibility with existing plain-text configs.
 */
export function isEncrypted(value: string): boolean {
    try {
        // Plain JSON starts with '{', encrypted starts with base64 chars
        if (value.startsWith('{')) return false;
        const decoded = Buffer.from(value, 'base64');
        return decoded.length > IV_LENGTH + TAG_LENGTH;
    } catch {
        return false;
    }
}

/**
 * Decrypt config or return as-is if it's plain JSON (backward compatible).
 */
export function decryptConfigSafe(value: string): string {
    if (isEncrypted(value)) {
        return decryptCredentials(value);
    }
    return value;
}
