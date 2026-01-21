import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import * as fs from 'fs';
import { Construct } from 'constructs';

/**
 * Props for EdgeLabStack with canary deployment support
 */
export interface EdgeLabStackProps extends cdk.StackProps {
  /**
   * Enable canary deployment mode.
   * When true, creates a staging distribution with continuous deployment policy
   * for safe, gradual rollout of CloudFront Function changes.
   * @default false
   */
  enableCanary?: boolean;
}

export class EdgeLabStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: EdgeLabStackProps) {
    super(scope, id, props);

    const enableCanary = props?.enableCanary ?? false;

    // Shared secret value for bot validation
    const botSecretValue = 'my-secret-key-2024';

    // ============================================
    // Secrets Manager Secret (for Lambda@Edge)
    // ============================================
    const botSecret = new secretsmanager.Secret(this, 'BotValidatorSecret', {
      secretName: 'bot-validator-secret',
      description: 'Secret key for bot validation HMAC signature',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ secretKey: botSecretValue }),
        generateStringKey: 'randomSuffix', // This won't be used, but required
      },
    });

    // Override with our actual secret value
    const cfnSecret = botSecret.node.defaultChild as secretsmanager.CfnSecret;
    cfnSecret.addPropertyOverride('SecretString', JSON.stringify({ secretKey: botSecretValue }));
    cfnSecret.addPropertyDeletionOverride('GenerateSecretString');

    // ============================================
    // CloudFront KeyValueStore (for CloudFront Functions)
    // ============================================
    const keyValueStore = new cloudfront.KeyValueStore(this, 'BotValidatorKVS', {
      keyValueStoreName: 'bot-validator-kvs',
      comment: 'KeyValueStore for bot validation secret',
    });

    // ============================================
    // S3 bucket as origin for CloudFront
    // ============================================
    const originBucket = new s3.Bucket(this, 'OriginBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // ============================================
    // S3 bucket for CloudFront access logs
    // ============================================
    const logBucket = new s3.Bucket(this, 'AccessLogBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,  // Required for CloudFront logging
      lifecycleRules: [{
        expiration: cdk.Duration.days(30),  // Auto-delete logs after 30 days
      }],
    });

    // Deploy test content to S3
    new s3deploy.BucketDeployment(this, 'DeployTestContent', {
      sources: [s3deploy.Source.data('test.html', '<html><body><h1>Bot Validation Passed!</h1></body></html>')],
      destinationBucket: originBucket,
      destinationKeyPrefix: 'cf-function',
    });

    new s3deploy.BucketDeployment(this, 'DeployTestContentLambda', {
      sources: [s3deploy.Source.data('test.html', '<html><body><h1>Bot Validation Passed!</h1></body></html>')],
      destinationBucket: originBucket,
      destinationKeyPrefix: 'lambda-edge',
    });

    // ============================================
    // CloudFront Function with KeyValueStore
    // ============================================
    // Read the function code and replace the placeholder with actual KVS ARN
    const cfFunctionCodePath = path.join(__dirname, '../../cloudfront-function/bot-validator.js');
    let cfFunctionCode = fs.readFileSync(cfFunctionCodePath, 'utf-8');
    cfFunctionCode = cfFunctionCode.replace('KVS_ID_PLACEHOLDER', keyValueStore.keyValueStoreArn);

    const cfFunction = new cloudfront.Function(this, 'BotValidatorFunction', {
      code: cloudfront.FunctionCode.fromInline(cfFunctionCode),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Bot validation using CloudFront Function with KeyValueStore',
      keyValueStore: keyValueStore,
    });

    // ============================================
    // Lambda@Edge function with Secrets Manager
    // ============================================
    // Read the Lambda code and inject the secret ARN
    const lambdaCodePath = path.join(__dirname, '../../lambda-edge/index.js');
    let lambdaCode = fs.readFileSync(lambdaCodePath, 'utf-8');
    lambdaCode = lambdaCode.replace('SECRET_ARN_PLACEHOLDER', botSecret.secretArn);

    // Write the modified code to a temp directory for bundling
    const tempLambdaDir = path.join(__dirname, '../../lambda-edge-build');
    if (!fs.existsSync(tempLambdaDir)) {
      fs.mkdirSync(tempLambdaDir, { recursive: true });
    }
    fs.writeFileSync(path.join(tempLambdaDir, 'index.js'), lambdaCode);

    // Copy package.json for dependencies
    const packageJsonPath = path.join(__dirname, '../../lambda-edge/package.json');
    if (fs.existsSync(packageJsonPath)) {
      fs.copyFileSync(packageJsonPath, path.join(tempLambdaDir, 'package.json'));
    }

    // Run npm install locally before CDK bundling (avoids Docker dependency)
    const { execFileSync } = require('child_process');
    try {
      execFileSync('npm', ['install'], { cwd: tempLambdaDir, stdio: 'inherit' });
    } catch (error) {
      console.error('Failed to run npm install for Lambda@Edge:', error);
      throw error;
    }

    const lambdaEdgeFunction = new lambda.Function(this, 'BotValidatorLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(tempLambdaDir),
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      description: 'Bot validation using Lambda@Edge with Secrets Manager',
    });

    // Grant Lambda@Edge permission to read the secret
    botSecret.grantRead(lambdaEdgeFunction);

    // Lambda@Edge needs specific trust policy for edgelambda.amazonaws.com
    const lambdaRole = lambdaEdgeFunction.role as iam.Role;
    lambdaRole.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('edgelambda.amazonaws.com')],
        actions: ['sts:AssumeRole'],
      })
    );

    // Lambda@Edge needs permission to read secrets from us-east-1
    lambdaEdgeFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [botSecret.secretArn],
      })
    );

    // Get the function version for Lambda@Edge
    const lambdaEdgeVersion = lambdaEdgeFunction.currentVersion;

    // ============================================
    // Origin Access Control for S3
    // ============================================
    const oac = new cloudfront.S3OriginAccessControl(this, 'OAC', {
      signing: cloudfront.Signing.SIGV4_ALWAYS,
    });

    // S3 origin with OAC
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(originBucket, {
      originAccessControl: oac,
    });

    // ============================================
    // CloudFront distribution with two cache behaviors
    // ============================================
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
      },
      additionalBehaviors: {
        // CloudFront Function path
        '/cf-function/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
          functionAssociations: [{
            function: cfFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          }],
        },
        // Lambda@Edge path
        '/lambda-edge/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
          edgeLambdas: [{
            functionVersion: lambdaEdgeVersion,
            eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST,
          }],
        },
      },
      comment: 'CloudFront Edge Function Comparison Lab',
      enableLogging: true,
      logBucket: logBucket,
      logFilePrefix: 'cloudfront-logs/',
      logIncludesCookies: false,
    });

    // ============================================
    // Canary Deployment (Continuous Deployment)
    // ============================================
    // Only create staging distribution when canary mode is enabled
    if (enableCanary) {
      // Create a staging CloudFront Function (can have different code for testing)
      // In practice, you'd modify this code to test new functionality
      const stagingCfFunction = new cloudfront.Function(this, 'StagingBotValidatorFunction', {
        code: cloudfront.FunctionCode.fromInline(cfFunctionCode),
        runtime: cloudfront.FunctionRuntime.JS_2_0,
        comment: 'STAGING - Bot validation using CloudFront Function with KeyValueStore',
        keyValueStore: keyValueStore,
      });

      // Create staging distribution (copy of primary with staging function)
      const stagingDistribution = new cloudfront.Distribution(this, 'StagingDistribution', {
        defaultBehavior: {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
        },
        additionalBehaviors: {
          // CloudFront Function path - uses STAGING function
          '/cf-function/*': {
            origin: s3Origin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
            originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
            functionAssociations: [{
              function: stagingCfFunction, // Uses staging function
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            }],
          },
          // Lambda@Edge path - same as primary (Lambda@Edge canary is separate)
          '/lambda-edge/*': {
            origin: s3Origin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
            originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
            edgeLambdas: [{
              functionVersion: lambdaEdgeVersion,
              eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST,
            }],
          },
        },
        comment: 'STAGING - CloudFront Edge Function Comparison Lab',
      });

      // Mark staging distribution as staging type using L1 escape hatch
      const cfnStagingDistribution = stagingDistribution.node.defaultChild as cloudfront.CfnDistribution;
      cfnStagingDistribution.addPropertyOverride('DistributionConfig.Staging', true);

      // Create Continuous Deployment Policy
      // Traffic configuration: Header-based routing for controlled testing
      const continuousDeploymentPolicy = new cloudfront.CfnContinuousDeploymentPolicy(
        this, 'CanaryDeploymentPolicy', {
          continuousDeploymentPolicyConfig: {
            enabled: true,
            stagingDistributionDnsNames: [stagingDistribution.distributionDomainName],
            trafficConfig: {
              // Using header-based routing for controlled canary testing
              // Requests with 'aws-cf-cd-staging: true' header go to staging
              type: 'SingleHeader',
              singleHeaderConfig: {
                header: 'aws-cf-cd-staging',
                value: 'true',
              },
            },
          },
        }
      );

      // Attach continuous deployment policy to primary distribution
      const cfnDistribution = distribution.node.defaultChild as cloudfront.CfnDistribution;
      cfnDistribution.addPropertyOverride(
        'DistributionConfig.ContinuousDeploymentPolicyId',
        continuousDeploymentPolicy.attrId
      );

      // Canary-specific outputs
      new cdk.CfnOutput(this, 'StagingDistributionDomainName', {
        value: stagingDistribution.distributionDomainName,
        description: 'Staging Distribution Domain Name (for canary testing)',
      });

      new cdk.CfnOutput(this, 'StagingDistributionId', {
        value: stagingDistribution.distributionId,
        description: 'Staging Distribution ID (needed for promotion)',
      });

      new cdk.CfnOutput(this, 'CanaryTestCommand', {
        value: `curl -H "aws-cf-cd-staging: true" https://${distribution.distributionDomainName}/cf-function/test.html`,
        description: 'Command to test the staging distribution via header-based routing',
      });

      new cdk.CfnOutput(this, 'PromoteCommand', {
        value: `aws cloudfront update-distribution-with-staging-config --id ${distribution.distributionId} --staging-distribution-id ${stagingDistribution.distributionId} --if-match <ETAG>`,
        description: 'Command to promote staging to primary (replace <ETAG> with current ETag)',
      });
    }

    // ============================================
    // Outputs
    // ============================================
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFront Distribution Domain Name',
    });

    new cdk.CfnOutput(this, 'CloudFrontFunctionTestUrl', {
      value: `https://${distribution.distributionDomainName}/cf-function/test.html`,
      description: 'Test URL for CloudFront Function validation',
    });

    new cdk.CfnOutput(this, 'LambdaEdgeTestUrl', {
      value: `https://${distribution.distributionDomainName}/lambda-edge/test.html`,
      description: 'Test URL for Lambda@Edge validation',
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: originBucket.bucketName,
      description: 'S3 Origin Bucket Name',
    });

    new cdk.CfnOutput(this, 'SecretArn', {
      value: botSecret.secretArn,
      description: 'Secrets Manager Secret ARN (for Lambda@Edge)',
    });

    new cdk.CfnOutput(this, 'KeyValueStoreArn', {
      value: keyValueStore.keyValueStoreArn,
      description: 'CloudFront KeyValueStore ARN',
    });

    new cdk.CfnOutput(this, 'KeyValueStoreInitCommand', {
      value: `aws cloudfront-keyvaluestore put-key --kvs-arn ${keyValueStore.keyValueStoreArn} --key bot-secret-key --value ${botSecretValue} --if-match $(aws cloudfront-keyvaluestore describe-key-value-store --kvs-arn ${keyValueStore.keyValueStoreArn} --query 'ETag' --output text)`,
      description: 'Run this command after deployment to initialize the KeyValueStore with the secret',
    });

    new cdk.CfnOutput(this, 'AccessLogBucketName', {
      value: logBucket.bucketName,
      description: 'S3 bucket containing CloudFront access logs',
    });

    new cdk.CfnOutput(this, 'AthenaQueryExample', {
      value: `SELECT date, time, "cs-uri-stem", "sc-status", COUNT(*) as count FROM cloudfront_logs WHERE "cs-uri-stem" LIKE '/cf-function/%' OR "cs-uri-stem" LIKE '/lambda-edge/%' GROUP BY date, time, "cs-uri-stem", "sc-status"`,
      description: 'Example Athena query to analyze bot validation results',
    });
  }
}
