# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a comparison lab for implementing bot detection at the CloudFront edge using two approaches:
- **CloudFront Functions** (JavaScript Runtime 2.0) - sub-millisecond, millions req/sec
- **Lambda@Edge** (Node.js) - milliseconds, ~10K/sec per region, must deploy in us-east-1

Both implementations validate HTTP requests using HMAC-SHA256 signature verification with two headers:
- `X-Bot-Token`: Unix timestamp
- `X-Bot-Signature`: HMAC-SHA256(token, SECRET_KEY) as hex string

## Architecture

```
cloudfront-lambda-edge-lab/
├── cloudfront-function/
│   └── bot-validator.js         # CloudFront Function (Runtime 2.0 with crypto)
├── lambda-edge/
│   └── index.js                 # Lambda@Edge handler (Node.js crypto module)
├── cdk/
│   ├── lib/edge-lab-stack.ts    # CDK stack definition
│   ├── bin/app.ts               # CDK app entry point
│   ├── package.json
│   └── cdk.json
└── test/
    └── test-requests.sh         # Test script
```

The CDK stack creates:
- S3 bucket as simple test origin
- CloudFront distribution with two cache behaviors:
  - `/cf-function/*` → CloudFront Function validation
  - `/lambda-edge/*` → Lambda@Edge validation

## Build and Deploy Commands

```bash
# Navigate to CDK directory
cd cdk

# Install dependencies
npm install

# Deploy the stack (Lambda@Edge requires us-east-1)
cdk deploy

# Destroy the stack
cdk destroy
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

## Key Implementation Notes

- CloudFront Functions use JavaScript Runtime 2.0 for native crypto support
- Lambda@Edge functions must be deployed in us-east-1 and are replicated to edge locations
- Both validate at the viewer-request stage (before hitting origin)
- Use constant-time comparison for signature validation to prevent timing attacks
- Optional timestamp validation (5-minute window) prevents replay attacks
