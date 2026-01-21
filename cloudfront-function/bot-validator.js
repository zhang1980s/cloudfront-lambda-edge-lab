// CloudFront Function - Bot Validator with KeyValueStore
// Uses JavaScript Runtime 2.0 with crypto and KeyValueStore support

import crypto from 'crypto';
import cf from 'cloudfront';

// KeyValueStore ID is injected during deployment via CDK
// The KVS_ID will be replaced by the actual KeyValueStore ARN
var kvsId = 'KVS_ID_PLACEHOLDER';
var kvsHandle;

// Initialize KeyValueStore handle
try {
    kvsHandle = cf.kvs(kvsId);
} catch (err) {
    console.log('KeyValueStore initialization failed: ' + err);
}

// Timestamp tolerance in seconds (5 minutes)
var TIMESTAMP_TOLERANCE = 300;

async function handler(event) {
    var request = event.request;
    var headers = request.headers;

    // Get secret key from KeyValueStore
    var secretKey;
    try {
        secretKey = await kvsHandle.get('bot-secret-key');
    } catch (err) {
        console.log('Failed to retrieve secret from KeyValueStore: ' + err);
        return {
            statusCode: 500,
            statusDescription: 'Internal Server Error',
            headers: {
                'content-type': { value: 'application/json' }
            },
            body: {
                encoding: 'text',
                data: JSON.stringify({ error: 'Configuration error' })
            }
        };
    }

    // Extract bot validation headers
    var token = headers['x-bot-token'] ? headers['x-bot-token'].value : null;
    var signature = headers['x-bot-signature'] ? headers['x-bot-signature'].value : null;

    // Reject if either header is missing
    if (!token || !signature) {
        return {
            statusCode: 403,
            statusDescription: 'Forbidden',
            headers: {
                'content-type': { value: 'application/json' }
            },
            body: {
                encoding: 'text',
                data: JSON.stringify({ error: 'Missing required headers: X-Bot-Token and X-Bot-Signature' })
            }
        };
    }

    // Optional: Validate timestamp to prevent replay attacks
    var tokenTimestamp = parseInt(token, 10);
    var currentTimestamp = Math.floor(Date.now() / 1000);

    if (isNaN(tokenTimestamp) || Math.abs(currentTimestamp - tokenTimestamp) > TIMESTAMP_TOLERANCE) {
        return {
            statusCode: 403,
            statusDescription: 'Forbidden',
            headers: {
                'content-type': { value: 'application/json' }
            },
            body: {
                encoding: 'text',
                data: JSON.stringify({ error: 'Token expired or invalid timestamp' })
            }
        };
    }

    // Compute expected signature using HMAC-SHA256
    var expectedSignature = crypto.createHmac('sha256', secretKey)
        .update(token)
        .digest('hex');

    // Constant-time comparison to prevent timing attacks
    if (!constantTimeCompare(signature, expectedSignature)) {
        return {
            statusCode: 403,
            statusDescription: 'Forbidden',
            headers: {
                'content-type': { value: 'application/json' }
            },
            body: {
                encoding: 'text',
                data: JSON.stringify({ error: 'Invalid signature' })
            }
        };
    }

    // Validation passed - allow request to proceed
    return request;
}

// Export the handler for CloudFront Functions
// eslint-disable-next-line no-unused-vars
var handlerExport = handler;

// Constant-time string comparison to prevent timing attacks
function constantTimeCompare(a, b) {
    if (a.length !== b.length) {
        return false;
    }

    var result = 0;
    for (var i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
}
