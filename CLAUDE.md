# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a comparison lab for implementing bot detection at the CloudFront edge using two approaches:
- **CloudFront Functions** (JavaScript Runtime 2.0) - sub-millisecond, millions req/sec, uses KeyValueStore for secrets
- **Lambda@Edge** (Node.js) - milliseconds, ~10K/sec per region, uses Secrets Manager for secrets

Both implementations validate HTTP requests using HMAC-SHA256 signature verification with two headers:
- `X-Bot-Token`: Unix timestamp
- `X-Bot-Signature`: HMAC-SHA256(token, SECRET_KEY) as hex string

## Architecture

```
cloudfront-lambda-edge-lab/
├── cloudfront-function/
│   └── bot-validator.js         # CloudFront Function (Runtime 2.0 with crypto + KeyValueStore)
├── lambda-edge/
│   ├── index.js                 # Lambda@Edge handler (Secrets Manager integration)
│   └── package.json             # Dependencies (@aws-sdk/client-secrets-manager)
├── cdk/
│   ├── lib/edge-lab-stack.ts    # CDK stack definition (with canary deployment support)
│   ├── bin/app.ts               # CDK app entry point
│   ├── package.json
│   └── cdk.json
└── test/
    ├── test-requests.sh         # Test script
    └── test-canary.sh           # Canary deployment test script
```

The CDK stack creates:
- **Secrets Manager secret** (`bot-validator-secret`) for Lambda@Edge
- **CloudFront KeyValueStore** (`bot-validator-kvs`) for CloudFront Functions
- S3 bucket as simple test origin
- S3 bucket for CloudFront access logs (30-day retention)
- CloudFront distribution with two cache behaviors:
  - `/cf-function/*` → CloudFront Function validation (reads secret from KeyValueStore)
  - `/lambda-edge/*` → Lambda@Edge validation (reads secret from Secrets Manager)

## Secret Storage Approaches

### CloudFront Functions + KeyValueStore
- No network access, so cannot call Secrets Manager
- Uses CloudFront KeyValueStore - globally distributed, sub-millisecond access
- Secret must be initialized after deployment using AWS CLI

### Lambda@Edge + Secrets Manager
- Full network access, can call AWS services
- Fetches secret from Secrets Manager in us-east-1
- Caches secret in memory (5-minute TTL) to reduce latency
- Cannot use environment variables (viewer-request restriction), so secret ARN is injected at build time

## Build and Deploy Commands

```bash
# Navigate to CDK directory
cd cdk

# Install dependencies
npm install

# Deploy the stack (Lambda@Edge requires us-east-1)
cdk deploy

# IMPORTANT: After deployment, initialize KeyValueStore with the secret
# The command is provided in the stack outputs (KeyValueStoreInitCommand)

# Destroy the stack
cdk destroy
```

## Post-Deployment Setup

After deploying, you must initialize the KeyValueStore with the secret key:

```bash
# Use the command from stack output KeyValueStoreInitCommand
aws cloudfront-keyvaluestore put-key \
  --kvs-arn <KeyValueStoreArn> \
  --key bot-secret-key \
  --value my-secret-key-2024 \
  --if-match $(aws cloudfront-keyvaluestore describe-key-value-store \
    --kvs-arn <KeyValueStoreArn> \
    --query 'ETag' --output text)
```

## Testing

Use the test script to run all test scenarios:

```bash
# Run full test suite (pass CloudFront domain from stack output)
./test/test-requests.sh <distribution-domain>

# Example
./test/test-requests.sh d123abc.cloudfront.net
```

The test script runs 7 scenarios: valid requests, missing headers, invalid signatures, and expired tokens for both CloudFront Function and Lambda@Edge paths.

## Canary Deployment

The stack supports **CloudFront Continuous Deployment** for safe rollout of CloudFront Function changes.

### Enable Canary Mode

```bash
# Deploy with canary mode
cdk deploy --context canary=true
```

This creates:
- A staging distribution with the CloudFront Function
- A continuous deployment policy with header-based routing
- Linking between primary and staging distributions

### Test Staging Distribution

```bash
# Test staging via header-based routing
curl -H "aws-cf-cd-staging: true" \
     -H "X-Bot-Token: $TOKEN" \
     -H "X-Bot-Signature: $SIGNATURE" \
     https://<distribution>/cf-function/test.html

# Run canary test suite
./test/test-canary.sh <distribution-domain>
```

### Promote to Production

```bash
aws cloudfront update-distribution-with-staging-config \
  --id <PRIMARY_DIST_ID> \
  --staging-distribution-id <STAGING_DIST_ID> \
  --if-match <ETAG>
```

### Canary-Specific Outputs

When `--context canary=true`:
- `StagingDistributionDomainName` - Staging distribution domain
- `StagingDistributionId` - For promotion command
- `CanaryTestCommand` - Ready-to-use test command
- `PromoteCommand` - Promotion command template

## Key Implementation Notes

- CloudFront Functions use JavaScript Runtime 2.0 for native crypto and KeyValueStore support
- Lambda@Edge functions must be deployed in us-east-1 and are replicated to edge locations
- Lambda@Edge cannot use environment variables for viewer-request triggers
- Both validate at the viewer-request stage (before hitting origin)
- Use constant-time comparison for signature validation to prevent timing attacks
- Optional timestamp validation (5-minute window) prevents replay attacks
- Lambda@Edge caches Secrets Manager responses for 5 minutes to reduce latency

## Stack Outputs

After deployment, the stack outputs include:
- `DistributionDomainName` - CloudFront domain for testing
- `CloudFrontFunctionTestUrl` - Direct URL to test CloudFront Function path
- `LambdaEdgeTestUrl` - Direct URL to test Lambda@Edge path
- `SecretArn` - Secrets Manager secret ARN
- `KeyValueStoreArn` - CloudFront KeyValueStore ARN
- `KeyValueStoreInitCommand` - AWS CLI command to initialize the KeyValueStore
- `AccessLogBucketName` - S3 bucket containing CloudFront access logs
- `AthenaQueryExample` - Example Athena query to analyze bot validation results

With `--context canary=true`, additional outputs:
- `StagingDistributionDomainName` - Staging distribution domain
- `StagingDistributionId` - Staging distribution ID (for promotion)
- `CanaryTestCommand` - curl command to test staging via header
- `PromoteCommand` - Command template to promote staging to primary

## Access Logs

CloudFront access logs are enabled to monitor bot validation pass/fail rates:
- Logs written to S3 with `cloudfront-logs/` prefix
- 30-day retention policy auto-deletes old logs
- Query with AWS CLI or Athena for analysis

```bash
# List log files
aws s3 ls s3://<AccessLogBucketName>/cloudfront-logs/

# Download and inspect
aws s3 cp s3://<AccessLogBucketName>/cloudfront-logs/XXXX.gz - | gunzip | head -20
```

Key fields: `sc-status` (200=passed, 403=blocked), `cs-uri-stem` (request path), `date`, `time`, `c-ip`
