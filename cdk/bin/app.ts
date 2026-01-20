#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { EdgeLabStack } from '../lib/edge-lab-stack';

const app = new cdk.App();

// Lambda@Edge must be deployed in us-east-1
new EdgeLabStack(app, 'EdgeLabStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  crossRegionReferences: true,
});
