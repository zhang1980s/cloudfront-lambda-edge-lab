#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { EdgeLabStack } from '../lib/edge-lab-stack';

const app = new cdk.App();

// Check if canary deployment mode is enabled via context
// Usage: cdk deploy --context canary=true
const enableCanary = app.node.tryGetContext('canary') === 'true';

// Lambda@Edge must be deployed in us-east-1
new EdgeLabStack(app, 'EdgeLabStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  crossRegionReferences: true,
  enableCanary,
});
