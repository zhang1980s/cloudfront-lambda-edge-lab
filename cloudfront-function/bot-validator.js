// CloudFront Function - Bot Validator
// Uses JavaScript Runtime 2.0 with crypto support

import crypto from 'crypto';

// Shared secret for HMAC validation (in production, use AWS Secrets Manager or Parameter Store)
var SECRET_KEY = 'my-secret-key-2024';

// Timestamp tolerance in seconds (5 minutes)
var TIMESTAMP_TOLERANCE = 300;

function handler(event) {
    var request = event.request;
    var headers = request.headers;

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
    var expectedSignature = crypto.createHmac('sha256', SECRET_KEY)
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
