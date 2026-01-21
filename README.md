# CloudFront Edge Function Comparison Lab

## Objective

Build a lab to understand how Lambda@Edge and CloudFront Functions work with CloudFront to validate HTTP requests at the edge. Implement the same bot detection logic using both approaches to compare capabilities, performance, and use cases.

## Requirements

- Two security fields in HTTP headers validate if request originates from a bot
- Validation uses crypto/SHA256 functions
- Invalid requests rejected immediately at the edge (403 response)

## Secret Management Architecture

This lab demonstrates two different approaches for storing secrets at the edge:

### CloudFront Functions + KeyValueStore

CloudFront Functions cannot make network calls, so they cannot access AWS services like Secrets Manager. Instead, they use **CloudFront KeyValueStore** - a globally distributed key-value data store designed specifically for CloudFront Functions.

```
┌─────────────────────────────────────────────────────────────┐
│                    CloudFront Function                       │
│  ┌─────────────┐      ┌─────────────────────────────────┐  │
│  │   Request   │ ───▶ │  KeyValueStore (global, <1ms)   │  │
│  │  Validation │ ◀─── │  key: "bot-secret-key"          │  │
│  └─────────────┘      └─────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Key characteristics:**
- Sub-millisecond read latency (data is co-located with function)
- No network calls required (in-memory access)
- Eventually consistent (updates propagate globally in ~seconds)
- Maximum 5MB total storage per KeyValueStore
- Requires JavaScript Runtime 2.0

### Lambda@Edge + Secrets Manager

Lambda@Edge has full network access and can call AWS services. This implementation uses **AWS Secrets Manager** to securely store and retrieve secrets.

```
┌─────────────────────────────────────────────────────────────┐
│                      Lambda@Edge                             │
│  ┌─────────────┐      ┌─────────────────────────────────┐  │
│  │   Request   │ ───▶ │  Secrets Manager (us-east-1)    │  │
│  │  Validation │ ◀─── │  secret: "bot-validator-secret" │  │
│  └─────────────┘      └─────────────────────────────────┘  │
│         │                                                    │
│         ▼                                                    │
│  ┌─────────────────┐                                        │
│  │  In-Memory Cache │  (5-minute TTL)                       │
│  └─────────────────┘                                        │
└─────────────────────────────────────────────────────────────┘
```

**Key characteristics:**
- Network call to Secrets Manager (~50-100ms first call)
- Secret caching reduces subsequent latency
- Centralized secret management with rotation support
- Full Secrets Manager features (versioning, audit, rotation)
- Lambda@Edge must call us-east-1 (where secrets are stored)

### Comparison

| Aspect | CloudFront Functions + KVS | Lambda@Edge + Secrets Manager |
|--------|---------------------------|------------------------------|
| **Latency** | Sub-millisecond | ~50-100ms (first call), cached after |
| **Network Required** | No | Yes |
| **Secret Rotation** | Manual (API call to update KVS) | Automatic with Secrets Manager |
| **Audit Trail** | CloudTrail for KVS API calls | Full Secrets Manager audit |
| **Max Secret Size** | 1KB per value | 64KB per secret |
| **Cost** | Free (included with CF Functions) | Secrets Manager pricing |
| **Cold Start Impact** | None | Additional ~50-100ms |

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

**Files structure:**
```
cloudfront-lambda-edge-lab/
├── README.md                    # Lab overview
├── CLAUDE.md                    # AI assistant guidance
├── cloudfront-function/
│   └── bot-validator.js         # CloudFront Function with KeyValueStore
├── lambda-edge/
│   ├── index.js                 # Lambda@Edge handler with Secrets Manager
│   └── package.json             # Dependencies (@aws-sdk/client-secrets-manager)
├── cdk/
│   ├── lib/
│   │   └── edge-lab-stack.ts    # CDK stack (with canary deployment support)
│   ├── bin/
│   │   └── app.ts               # CDK app entry
│   ├── package.json
│   └── cdk.json
└── test/
    ├── test-requests.sh         # Test script
    └── test-canary.sh           # Canary deployment test script
```

### Phase 2: CloudFront Function Implementation

**File: `cloudfront-function/bot-validator.js`**

- Use JavaScript Runtime 2.0
- Import `crypto` module for SHA256 and `cloudfront` module for KeyValueStore
- Read secret key from CloudFront KeyValueStore
- Read 2 security headers from viewer request
- Compute hash and validate
- Return 403 response if validation fails
- Pass request through if valid

### Phase 3: Lambda@Edge Implementation

**File: `lambda-edge/index.js`**

- Node.js 20.x runtime
- Use AWS SDK v3 (`@aws-sdk/client-secrets-manager`)
- Fetch secret from Secrets Manager in us-east-1
- Cache secret in memory (5-minute TTL) to reduce latency
- Same validation logic as CloudFront Function
- Handler for viewer-request event
- Return 403 or allow passthrough

### Phase 4: CDK Infrastructure

**File: `cdk/lib/edge-lab-stack.ts`**

- Create Secrets Manager secret for Lambda@Edge
- Create CloudFront KeyValueStore for CloudFront Functions
- Create S3 bucket as origin (simple test origin)
- Create CloudFront distribution
- Deploy CloudFront Function with KeyValueStore association
- Deploy Lambda@Edge function with Secrets Manager permissions (us-east-1)
- Create 2 cache behaviors to test each approach:
  - `/cf-function/*` → CloudFront Function validation
  - `/lambda-edge/*` → Lambda@Edge validation

### Phase 5: Post-Deployment Setup

After deploying the CDK stack, you must initialize the KeyValueStore with the secret:

```bash
# The command is provided in the stack outputs
# Example:
aws cloudfront-keyvaluestore put-key \
  --kvs-arn <KeyValueStoreArn from output> \
  --key bot-secret-key \
  --value my-secret-key-2024 \
  --if-match $(aws cloudfront-keyvaluestore describe-key-value-store \
    --kvs-arn <KeyValueStoreArn from output> \
    --query 'ETag' --output text)
```

### Phase 6: Testing & Comparison

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
| Secret Storage | CloudFront KeyValueStore | AWS Secrets Manager |
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

## Canary Deployment

This lab includes support for **CloudFront Continuous Deployment** to safely roll out changes to CloudFront Functions using a canary deployment pattern.

### How It Works

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CloudFront Distribution                          │
│                                                                          │
│   Normal Request ──────────────────────────────▶ PRIMARY Distribution    │
│                                                   (Production Function)  │
│                                                                          │
│   Request with Header ─────────────────────────▶ STAGING Distribution    │
│   "aws-cf-cd-staging: true"                       (Canary Function)      │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

CloudFront Continuous Deployment creates a **staging distribution** that mirrors your primary distribution. Traffic is routed to staging based on:
- **Header-based routing**: Requests with `aws-cf-cd-staging: true` header go to staging
- **Weight-based routing**: A percentage (1-15%) of all traffic goes to staging

### Enable Canary Deployment

```bash
# Deploy with canary mode enabled
cd cdk
cdk deploy --context canary=true
```

This creates:
- A staging distribution with your CloudFront Function changes
- A continuous deployment policy with header-based routing
- The primary distribution linked to the staging distribution

### Test the Staging Distribution

```bash
# Test PRIMARY distribution (normal request)
curl -H "X-Bot-Token: $TOKEN" \
     -H "X-Bot-Signature: $SIGNATURE" \
     https://<distribution>/cf-function/test.html

# Test STAGING distribution (with canary header)
curl -H "aws-cf-cd-staging: true" \
     -H "X-Bot-Token: $TOKEN" \
     -H "X-Bot-Signature: $SIGNATURE" \
     https://<distribution>/cf-function/test.html

# Run the canary test suite
./test/test-canary.sh <distribution-domain>
```

### Promote Staging to Primary

When satisfied with testing, promote the staging configuration to primary:

```bash
# Get the distribution ETags
PRIMARY_ETAG=$(aws cloudfront get-distribution --id <PRIMARY_ID> --query 'ETag' --output text)

# Promote staging to primary
aws cloudfront update-distribution-with-staging-config \
  --id <PRIMARY_ID> \
  --staging-distribution-id <STAGING_ID> \
  --if-match $PRIMARY_ETAG
```

### Canary Deployment Outputs

When deployed with `--context canary=true`, additional outputs are provided:
- `StagingDistributionDomainName` - Staging distribution domain
- `StagingDistributionId` - Staging distribution ID (for promotion)
- `CanaryTestCommand` - Ready-to-use curl command for testing staging
- `PromoteCommand` - Command template for promoting staging to primary

### Lambda@Edge Canary Deployment

Lambda@Edge does **not** support aliases in CloudFront edge associations. For Lambda@Edge canary deployments, consider:
- Using AWS CodeDeploy with SAM for automated traffic shifting
- Manual version management with deployment scripts
- Multiple cache behaviors pointing to different Lambda versions

## Access Logs

CloudFront Access Logs are enabled by default to monitor bot validation pass/fail rates. Logs are written to an S3 bucket with a 30-day retention policy.

### What Gets Logged

Each log entry includes:
- `sc-status` - Response status code (200 = passed, 403 = blocked)
- `cs-uri-stem` - Request path (`/cf-function/*` or `/lambda-edge/*`)
- `date`, `time` - Timestamp
- `c-ip` - Client IP address
- `cs-method` - HTTP method
- `x-edge-result-type` - Cache result (Error for blocked requests)

### Querying Logs

**Option A: AWS CLI (Quick Check)**

```bash
# List recent log files
aws s3 ls s3://<AccessLogBucketName>/cloudfront-logs/

# Download and inspect a log file
aws s3 cp s3://<AccessLogBucketName>/cloudfront-logs/XXXX.gz - | gunzip | head -20
```

**Option B: Athena (Recommended for Analysis)**

1. Create Athena table:

```sql
CREATE EXTERNAL TABLE cloudfront_logs (
  `date` DATE,
  `time` STRING,
  `x-edge-location` STRING,
  `sc-bytes` BIGINT,
  `c-ip` STRING,
  `cs-method` STRING,
  `cs-host` STRING,
  `cs-uri-stem` STRING,
  `sc-status` INT,
  `cs-referer` STRING,
  `cs-user-agent` STRING,
  `cs-uri-query` STRING,
  `cs-cookie` STRING,
  `x-edge-result-type` STRING,
  `x-edge-request-id` STRING,
  `x-host-header` STRING,
  `cs-protocol` STRING,
  `cs-bytes` BIGINT,
  `time-taken` FLOAT,
  `x-forwarded-for` STRING,
  `ssl-protocol` STRING,
  `ssl-cipher` STRING,
  `x-edge-response-result-type` STRING,
  `cs-protocol-version` STRING,
  `fle-status` STRING,
  `fle-encrypted-fields` INT,
  `c-port` INT,
  `time-to-first-byte` FLOAT,
  `x-edge-detailed-result-type` STRING,
  `sc-content-type` STRING,
  `sc-content-len` BIGINT,
  `sc-range-start` BIGINT,
  `sc-range-end` BIGINT
)
ROW FORMAT DELIMITED FIELDS TERMINATED BY '\t'
LOCATION 's3://<AccessLogBucketName>/cloudfront-logs/'
TBLPROPERTIES ('skip.header.line.count'='2');
```

2. Query pass/fail counts:

```sql
-- Count passed vs blocked by path
SELECT
  CASE
    WHEN "cs-uri-stem" LIKE '/cf-function/%' THEN 'CloudFront Function'
    WHEN "cs-uri-stem" LIKE '/lambda-edge/%' THEN 'Lambda@Edge'
    ELSE 'Other'
  END AS validator,
  CASE
    WHEN "sc-status" = 200 THEN 'PASSED'
    WHEN "sc-status" = 403 THEN 'BLOCKED'
    ELSE 'OTHER'
  END AS result,
  COUNT(*) AS request_count
FROM cloudfront_logs
WHERE "cs-uri-stem" LIKE '/cf-function/%'
   OR "cs-uri-stem" LIKE '/lambda-edge/%'
GROUP BY 1, 2
ORDER BY 1, 2;
```

### Stack Outputs for Logging

- `AccessLogBucketName` - S3 bucket containing CloudFront access logs
- `AthenaQueryExample` - Example Athena query for analyzing bot validation results

### Notes

- Logs are delivered every 5-10 minutes (not real-time)
- Log files are gzipped and tab-delimited
- 30-day retention keeps costs manageable
- For real-time analysis, consider CloudFront Real-Time Logs to Kinesis

## Notes

- Lambda@Edge must be deployed in us-east-1
- CloudFront Function uses Runtime 2.0 for crypto and KeyValueStore support
- Both approaches validate at viewer-request stage
- **Important**: After CDK deployment, you must initialize the KeyValueStore with the secret key (command provided in stack outputs)
- Lambda@Edge caches the secret for 5 minutes to minimize Secrets Manager calls
- Lambda@Edge cannot use environment variables for viewer-request triggers, so the secret ARN is injected at build time
