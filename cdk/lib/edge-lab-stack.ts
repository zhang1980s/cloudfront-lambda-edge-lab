import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as path from 'path';
import { Construct } from 'constructs';

export class EdgeLabStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 bucket as origin for CloudFront
    const originBucket = new s3.Bucket(this, 'OriginBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
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

    // CloudFront Function for bot validation
    const cfFunction = new cloudfront.Function(this, 'BotValidatorFunction', {
      code: cloudfront.FunctionCode.fromFile({
        filePath: path.join(__dirname, '../../cloudfront-function/bot-validator.js'),
      }),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Bot validation using CloudFront Function',
    });

    // Lambda@Edge function for bot validation
    const lambdaEdgeFunction = new lambda.Function(this, 'BotValidatorLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda-edge')),
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      description: 'Bot validation using Lambda@Edge',
    });

    // Grant Lambda@Edge permission to be invoked by CloudFront
    const lambdaEdgeVersion = lambdaEdgeFunction.currentVersion;

    // Origin Access Control for S3
    const oac = new cloudfront.S3OriginAccessControl(this, 'OAC', {
      signing: cloudfront.Signing.SIGV4_ALWAYS,
    });

    // S3 origin with OAC
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(originBucket, {
      originAccessControl: oac,
    });

    // CloudFront distribution with two cache behaviors
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
    });

    // Outputs
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
  }
}
