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

        // Parse the secret value (stored as JSON with 'secretKey' field)
        const secretData = JSON.parse(response.SecretString);
        cachedSecret = secretData.secretKey;
        cacheExpiry = now + CACHE_TTL;

        return cachedSecret;
    } catch (error) {
        console.error('Failed to retrieve secret from Secrets Manager:', error);
        throw error;
    }
}

exports.handler = async (event) => {
    const request = event.Records[0].cf.request;
    const headers = request.headers;

    // Get secret key from Secrets Manager
    let secretKey;
    try {
        secretKey = await getSecret();
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

    // Extract bot validation headers (headers are lowercase in Lambda@Edge)
    const token = headers['x-bot-token'] ? headers['x-bot-token'][0].value : null;
    const signature = headers['x-bot-signature'] ? headers['x-bot-signature'][0].value : null;

    // Reject if either header is missing
    if (!token || !signature) {
        return {
            status: '403',
            statusDescription: 'Forbidden',
            headers: {
                'content-type': [{ key: 'Content-Type', value: 'application/json' }]
            },
            body: JSON.stringify({ error: 'Missing required headers: X-Bot-Token and X-Bot-Signature' })
        };
    }

    // Optional: Validate timestamp to prevent replay attacks
    const tokenTimestamp = parseInt(token, 10);
    const currentTimestamp = Math.floor(Date.now() / 1000);

    if (isNaN(tokenTimestamp) || Math.abs(currentTimestamp - tokenTimestamp) > TIMESTAMP_TOLERANCE) {
        return {
            status: '403',
            statusDescription: 'Forbidden',
            headers: {
                'content-type': [{ key: 'Content-Type', value: 'application/json' }]
            },
            body: JSON.stringify({ error: 'Token expired or invalid timestamp' })
        };
    }

    // Compute expected signature using HMAC-SHA256
    const expectedSignature = crypto
        .createHmac('sha256', secretKey)
        .update(token)
        .digest('hex');

    // Constant-time comparison to prevent timing attacks
    if (!constantTimeCompare(signature, expectedSignature)) {
        return {
            status: '403',
            statusDescription: 'Forbidden',
            headers: {
                'content-type': [{ key: 'Content-Type', value: 'application/json' }]
            },
            body: JSON.stringify({ error: 'Invalid signature' })
        };
    }

    // Validation passed - allow request to proceed to origin
    return request;
};

// Constant-time string comparison to prevent timing attacks
function constantTimeCompare(a, b) {
    if (a.length !== b.length) {
        return false;
    }

    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
}
