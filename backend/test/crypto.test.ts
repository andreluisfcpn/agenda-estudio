import { describe, it, expect } from 'vitest';
import { encryptCredentials, decryptCredentials, isEncrypted, decryptConfigSafe } from '../src/utils/crypto';

describe('Crypto Utils', () => {
    const testData = JSON.stringify({ secretKey: 'sk_test_abc123', webhookSecret: 'whsec_xyz' });

    it('should encrypt and decrypt to same value', () => {
        const encrypted = encryptCredentials(testData);
        const decrypted = decryptCredentials(encrypted);
        expect(decrypted).toBe(testData);
    });

    it('should produce different ciphertext each time (random IV)', () => {
        const encrypted1 = encryptCredentials(testData);
        const encrypted2 = encryptCredentials(testData);
        expect(encrypted1).not.toBe(encrypted2);
    });

    it('should detect encrypted vs plain JSON', () => {
        const encrypted = encryptCredentials(testData);
        expect(isEncrypted(encrypted)).toBe(true);
        expect(isEncrypted(testData)).toBe(false);
        expect(isEncrypted('{"key":"value"}')).toBe(false);
    });

    it('decryptConfigSafe should pass through plain JSON', () => {
        const plain = '{"secretKey":"sk_test_abc"}';
        expect(decryptConfigSafe(plain)).toBe(plain);
    });

    it('decryptConfigSafe should decrypt encrypted data', () => {
        const encrypted = encryptCredentials(testData);
        expect(decryptConfigSafe(encrypted)).toBe(testData);
    });
});
