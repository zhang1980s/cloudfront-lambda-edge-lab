# CloudFront Edge Function Comparison Lab

## Objective

Build a lab to understand how Lambda@Edge and CloudFront Functions work with CloudFront to validate HTTP requests at the edge. Implement the same bot detection logic using both approaches to compare capabilities, performance, and use cases.

## Requirements

- Two security fields in HTTP headers validate if request originates from a bot
- Validation uses crypto/SHA256 functions
- Invalid requests rejected immediately at the edge (403 response)

## Bot Validation Design

### HTTP Headers

| Header | Purpose | Example Value |
|--------|---------|---------------|
| `X-Bot-Token` | Timestamp (Unix epoch in seconds) | `1737312000` |
| `X-Bot-Signature` | HMAC-SHA256 hash of the token using a shared secret | `a3f2b8c1d4e5...` (64-char hex string) |

### Validation Logic

```
1. Extract headers:
   - token = request.headers['X-Bot-Token']
   - signature = request.headers['X-Bot-Signature']

2. Reject if either header is missing → 403

3. Compute expected signature:
   expectedSignature = HMAC-SHA256(token, SECRET_KEY).toHex()

4. Compare signatures (constant-time comparison):
   - If signature === expectedSignature → Allow request
   - If mismatch → 403 Forbidden

5. (Optional) Timestamp validation:
   - Reject if token is older than 5 minutes → prevents replay attacks
```

### Example Request

**Shared Secret:** `my-secret-key-2024`

**Client Request:**
```bash
curl -H "X-Bot-Token: 1737312000" \
     -H "X-Bot-Signature: 7a8b9c0d1e2f..." \
     https://d123.cloudfront.net/cf-function/test.html
```

**Server Validation (pseudocode):**
```javascript
const expected = HMAC_SHA256(token, SECRET_KEY).toHex();
if (signature === expected) {
    // Allow request to proceed
} else {
    // Return 403 Forbidden
}
```

### Why HMAC-SHA256?

- **HMAC** (Hash-based Message Authentication Code) is more secure than plain SHA256 for authentication
- Prevents length extension attacks
- Industry standard for API signature validation

### Why Two Fields Instead of One?

| Single Token | Two Fields (Token + Signature) |
|--------------|-------------------------------|
| Static, can be stolen and replayed forever | Timestamp prevents replay attacks |
| If leaked, attacker has full access | Secret never transmitted, only the signature |
| Easy to brute force | HMAC is computationally expensive to forge |

The two-field pattern provides **proof of possession** of the secret without actually transmitting the secret.

### Real-World Use Cases

**1. Mobile App API Protection**

A company has a mobile app that calls their backend API. They want to ensure only their legitimate app (not scrapers or reverse-engineered clients) can access the API.

```
App generates:
- X-Bot-Token: current timestamp
- X-Bot-Signature: HMAC(timestamp, secret_embedded_in_app)

Server validates the signature matches → proves request came from the real app
```

**2. CDN-Protected Content Delivery**

A media streaming service wants to prevent unauthorized downloads of video content. Only their official player should access the CDN.

```
Player requests video:
- Token: session_id + timestamp
- Signature: proves the player has the signing key

CloudFront validates at edge → blocks wget/curl/scrapers before hitting origin
```

**3. API Gateway Rate Limiting Bypass Prevention**

An API offers higher rate limits for paid partners. Partners sign requests to prove their identity without sending API keys in plain text.

```
Partner request:
- X-Bot-Token: partner_id:timestamp
- X-Bot-Signature: HMAC proof

Prevents attackers from spoofing partner_id to get higher limits
```

**4. Webhook Authentication**

Service A sends webhooks to Service B. Service B needs to verify the webhook actually came from Service A (not an attacker).

```
Webhook from Service A:
- X-Webhook-Timestamp: when sent
- X-Webhook-Signature: HMAC(payload + timestamp, shared_secret)

Service B validates → prevents forged webhook injection
```

**5. IoT Device Authentication**

IoT devices communicate with cloud backend. Each device has a unique secret burned in at manufacturing.

```
Device request:
- X-Device-Token: device_id:timestamp
- X-Device-Signature: proves device has the secret

Backend validates → blocks spoofed device traffic
```

## Implementation Plan

### Phase 1: Project Setup

**Files to create:**
```
cloudfront-lambda-edge-lab/
├── README.md                    # Lab overview (update existing)
├── cloudfront-function/
│   └── bot-validator.js         # CloudFront Function code
├── lambda-edge/
│   └── index.js                 # Lambda@Edge handler
├── cdk/
│   ├── lib/
│   │   └── edge-lab-stack.ts    # CDK stack
│   ├── bin/
│   │   └── app.ts               # CDK app entry
│   ├── package.json
│   └── cdk.json
└── test/
    └── test-requests.sh         # Test script
```

### Phase 2: CloudFront Function Implementation

**File: `cloudfront-function/bot-validator.js`**

- Use JavaScript Runtime 2.0
- Import Crypto module for SHA256
- Read 2 security headers from viewer request
- Compute hash and validate
- Return 403 response if validation fails
- Pass request through if valid

### Phase 3: Lambda@Edge Implementation

**File: `lambda-edge/index.js`**

- Node.js runtime
- Use native crypto module for SHA256
- Same validation logic as CloudFront Function
- Handler for viewer-request event
- Return 403 or allow passthrough

### Phase 4: CDK Infrastructure

**File: `cdk/lib/edge-lab-stack.ts`**

- Create S3 bucket as origin (simple test origin)
- Create CloudFront distribution
- Deploy CloudFront Function
- Deploy Lambda@Edge function (us-east-1)
- Create 2 cache behaviors to test each approach:
  - `/cf-function/*` → CloudFront Function validation
  - `/lambda-edge/*` → Lambda@Edge validation

### Phase 5: Testing & Comparison

**Test scenarios:**
1. Valid headers → Request passes through
2. Invalid/tampered headers → 403 Forbidden
3. Missing headers → 403 Forbidden

**Comparison metrics:**
- Latency (CloudFront Functions should be faster)
- Cost structure differences
- Code complexity
- Deployment experience

## Key Differences to Highlight

| Aspect | CloudFront Functions | Lambda@Edge |
|--------|---------------------|-------------|
| Execution | Sub-millisecond | Milliseconds |
| Scale | Millions req/sec | ~10K/sec per region |
| Deploy Region | All edge locations | us-east-1 then replicated |
| Network Access | No | Yes |
| Best For | Simple, fast validation | Complex logic, external calls |

## Cost Comparison

### Pricing Model

| Component | CloudFront Functions | Lambda@Edge |
|-----------|---------------------|-------------|
| **Invocation** | $0.10 per 1 million invocations | $0.60 per 1 million invocations |
| **Compute** | Included in invocation price | $0.00000625125 per 128MB-ms |
| **Free Tier** | 2 million invocations/month | 1 million requests + 400,000 GB-sec/month |
| **Duration Billing** | None (sub-ms execution) | Per 1ms (minimum 1ms) |

### Cost Examples (Monthly)

**Scenario: 100 million requests/month**

| Cost Component | CloudFront Functions | Lambda@Edge (5ms avg) |
|----------------|---------------------|----------------------|
| Invocations | $10.00 | $60.00 |
| Compute (128MB) | $0.00 | $3.13 |
| **Total** | **$10.00** | **$63.13** |

**Scenario: 1 billion requests/month**

| Cost Component | CloudFront Functions | Lambda@Edge (5ms avg) |
|----------------|---------------------|----------------------|
| Invocations | $100.00 | $600.00 |
| Compute (128MB) | $0.00 | $31.26 |
| **Total** | **$100.00** | **$631.26** |

> **CloudFront Functions are ~6x cheaper** for simple request validation use cases.

### When Lambda@Edge Cost is Justified

- Need to make external API calls (authentication services, databases)
- Complex processing requiring more than 10KB code size
- Response body manipulation (CloudFront Functions limited to 2MB)
- Need access to request body in viewer request
- Execution time may exceed 1ms consistently

## Maintenance Comparison

| Aspect | CloudFront Functions | Lambda@Edge |
|--------|---------------------|-------------|
| **Code Size Limit** | 10 KB | 1 MB (viewer) / 50 MB (origin) |
| **Memory** | Fixed (2MB max) | 128 MB - 10,240 MB configurable |
| **Timeout** | < 1ms | 5 sec (viewer) / 30 sec (origin) |
| **Runtime** | JavaScript (ECMAScript 5.1 + Runtime 2.0) | Node.js, Python |
| **Deployment** | Instant (seconds) | Minutes (replication to all edges) |
| **Versioning** | Automatic | Manual version management required |
| **Logging** | CloudWatch Logs (sampled) | CloudWatch Logs (per region) |
| **Debugging** | Limited (no console.log in production) | Full CloudWatch integration |
| **IAM** | No IAM role needed | Requires execution role + trust policy |
| **VPC Access** | No | No (edge functions cannot access VPC) |

### Operational Considerations

**CloudFront Functions:**
- ✅ Simpler deployment and rollback
- ✅ No cold starts
- ✅ No version management overhead
- ⚠️ Limited debugging capabilities
- ⚠️ Strict resource constraints

**Lambda@Edge:**
- ✅ Full Node.js/Python ecosystem
- ✅ Detailed CloudWatch metrics per region
- ✅ Can handle complex business logic
- ⚠️ Cold start latency (50-200ms)
- ⚠️ Version/alias management required
- ⚠️ Logs scattered across regions
- ⚠️ Cannot delete function while replicas exist (wait ~30 min)

### Recommendation Matrix

| Use Case | Recommendation |
|----------|---------------|
| Header validation (this lab) | CloudFront Functions |
| URL rewriting/redirects | CloudFront Functions |
| Simple A/B testing | CloudFront Functions |
| Bot detection with external API | Lambda@Edge |
| Authentication with token validation | Lambda@Edge |
| Image optimization | Lambda@Edge |
| Complex response manipulation | Lambda@Edge |

## Verification Steps

1. Deploy CDK stack
2. Run test script with valid headers → expect 200
3. Run test script with invalid headers → expect 403
4. Compare CloudWatch metrics for latency
5. Review logs for both functions

## Notes

- Lambda@Edge must be deployed in us-east-1
- CloudFront Function uses Runtime 2.0 for crypto support
- Both approaches validate at viewer-request stage
