'use strict';

const crypto = require('crypto');

// Shared secret for HMAC validation (in production, use AWS Secrets Manager or Parameter Store)
const SECRET_KEY = 'my-secret-key-2024';

// Timestamp tolerance in seconds (5 minutes)
const TIMESTAMP_TOLERANCE = 300;

exports.handler = async (event) => {
    const request = event.Records[0].cf.request;
    const headers = request.headers;

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
        .createHmac('sha256', SECRET_KEY)
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
