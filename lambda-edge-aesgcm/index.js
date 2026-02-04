'use strict';

const crypto = require('crypto');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

// Secret name is injected during CDK deployment (Lambda@Edge doesn't support env vars)
// This placeholder will be replaced with the actual secret name
const SECRET_NAME = 'SECRET_NAME_PLACEHOLDER';

// Timestamp tolerance in seconds (5 minutes)
const TIMESTAMP_TOLERANCE = 300;

// Cache the secret to avoid repeated Secrets Manager calls
let cachedSecret = null;
let cacheExpiry = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

// Lambda@Edge runs in multiple regions, use us-east-1 where the secret is stored
const secretsClient = new SecretsManagerClient({ region: 'us-east-1' });

/**
 * Retrieve the AES-256-GCM key from Secrets Manager
 * The key must be exactly 32 bytes (256 bits) for AES-256
 */
async function getSecret() {
    const now = Date.now();

    // Return cached secret if still valid
    if (cachedSecret && now < cacheExpiry) {
        return cachedSecret;
    }

    try {
        const command = new GetSecretValueCommand({
            SecretId: SECRET_NAME,
        });

        const response = await secretsClient.send(command);

        // Parse the secret value (stored as JSON with 'aesKey' field)
        // The key should be a 32-byte hex string (64 characters)
        const secretData = JSON.parse(response.SecretString);
        cachedSecret = secretData.aesKey;
        cacheExpiry = now + CACHE_TTL;

        return cachedSecret;
    } catch (error) {
        console.error('Failed to retrieve secret from Secrets Manager:', error);
        throw error;
    }
}

/**
 * Decrypt and validate an AES-GCM encrypted token
 *
 * Token format: <nonce_hex>:<ciphertext_hex>:<auth_tag_hex>
 *
 * @param {string} token - The encrypted token
 * @param {string} keyHex - The AES-256 key as hex string (64 chars)
 * @returns {object|null} - Decrypted payload or null if invalid
 */
function decryptToken(token, keyHex) {
    try {
        const parts = token.split(':');
        if (parts.length !== 3) {
            console.error('Invalid token format: expected nonce:ciphertext:tag');
            return null;
        }

        const [nonceHex, ciphertextHex, authTagHex] = parts;

        // Convert hex strings to buffers
        const nonce = Buffer.from(nonceHex, 'hex');
        const ciphertext = Buffer.from(ciphertextHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');
        const key = Buffer.from(keyHex, 'hex');

        // Validate sizes
        if (nonce.length !== 12) {
            console.error('Invalid nonce length: expected 12 bytes, got', nonce.length);
            return null;
        }
        if (authTag.length !== 16) {
            console.error('Invalid auth tag length: expected 16 bytes, got', authTag.length);
            return null;
        }
        if (key.length !== 32) {
            console.error('Invalid key length: expected 32 bytes, got', key.length);
            return null;
        }

        // Create decipher
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAuthTag(authTag);

        // Decrypt
        let decrypted = decipher.update(ciphertext, null, 'utf8');
        decrypted += decipher.final('utf8');

        // Parse JSON payload
        const payload = JSON.parse(decrypted);
        return payload;

    } catch (error) {
        console.error('Decryption failed:', error.message);
        return null;
    }
}

/**
 * Validate the decrypted payload
 *
 * Expected payload format:
 * {
 *   "ts": <unix_timestamp>,      // Required: timestamp for replay protection
 *   "device": "<device_id>",     // Optional: device binding
 *   "data": "<custom_data>"      // Optional: any additional data
 * }
 */
function validatePayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return { valid: false, error: 'Invalid payload structure' };
    }

    // Validate timestamp exists and is a number
    if (typeof payload.ts !== 'number') {
        return { valid: false, error: 'Missing or invalid timestamp' };
    }

    // Check timestamp is within tolerance window
    const currentTimestamp = Math.floor(Date.now() / 1000);
    if (Math.abs(currentTimestamp - payload.ts) > TIMESTAMP_TOLERANCE) {
        return { valid: false, error: 'Token expired or invalid timestamp' };
    }

    // Optional: Validate device binding if device header is present
    // This would be extended in a real implementation

    return { valid: true };
}

exports.handler = async (event) => {
    const request = event.Records[0].cf.request;
    const headers = request.headers;

    // Get AES key from Secrets Manager
    let aesKey;
    try {
        aesKey = await getSecret();
    } catch (error) {
        console.error('Configuration error:', error);
        return {
            status: '500',
            statusDescription: 'Internal Server Error',
            headers: {
                'content-type': [{ key: 'Content-Type', value: 'application/json' }]
            },
            body: JSON.stringify({ error: 'Configuration error' })
        };
    }

    // Extract the encrypted auth token header (headers are lowercase in Lambda@Edge)
    const authToken = headers['x-auth-token'] ? headers['x-auth-token'][0].value : null;

    // Reject if header is missing
    if (!authToken) {
        return {
            status: '403',
            statusDescription: 'Forbidden',
            headers: {
                'content-type': [{ key: 'Content-Type', value: 'application/json' }]
            },
            body: JSON.stringify({ error: 'Missing required header: X-Auth-Token' })
        };
    }

    // Decrypt and validate the token
    const payload = decryptToken(authToken, aesKey);

    if (!payload) {
        return {
            status: '403',
            statusDescription: 'Forbidden',
            headers: {
                'content-type': [{ key: 'Content-Type', value: 'application/json' }]
            },
            body: JSON.stringify({ error: 'Invalid or corrupted token' })
        };
    }

    // Validate the payload contents
    const validation = validatePayload(payload);

    if (!validation.valid) {
        return {
            status: '403',
            statusDescription: 'Forbidden',
            headers: {
                'content-type': [{ key: 'Content-Type', value: 'application/json' }]
            },
            body: JSON.stringify({ error: validation.error })
        };
    }

    // Validation passed - allow request to proceed to origin
    // Optionally add decrypted info to request headers for downstream processing
    request.headers['x-validated-device'] = [{ key: 'X-Validated-Device', value: payload.device || 'unknown' }];
    request.headers['x-validated-timestamp'] = [{ key: 'X-Validated-Timestamp', value: String(payload.ts) }];

    return request;
};

/// abc