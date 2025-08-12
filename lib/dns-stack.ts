import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';

export interface DnsStackProps extends cdk.StackProps {
  environment: string;
  authApi: apigateway.RestApi;
}

export class GameAuthServiceDnsStack extends cdk.Stack {
  public readonly hostedZone: route53.IHostedZone;
  public readonly certificate: acm.Certificate;
  public readonly apiDomainName: string;

  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);

    const { environment, authApi } = props;

    // Domain configuration per environment
    const domainConfig = {
      test: {
        zoneName: 'test.game.loop1.io',
        apiSubdomain: 'auth'
      },
      qa: {
        zoneName: 'qa.game.loop1.io',
        apiSubdomain: 'auth'
      },
      production: {
        zoneName: 'prod.game.loop1.io',
        apiSubdomain: 'auth'
      }
    }[environment] || {
      zoneName: 'test.game.loop1.io',
      apiSubdomain: 'auth'
    };

    // Import hosted zone for this account's subdomain
    // Note: The hosted zone must be created first in this account
    // and NS records added to Ops account for delegation
    // See: https://github.com/loupeen/claude-docs/blob/main/docs/infrastructure/DNS-IMPLEMENTATION-GUIDE.md
    this.hostedZone = route53.HostedZone.fromLookup(this, 'GameZone', {
      domainName: domainConfig.zoneName
    });

    // Full domain name for the auth API
    this.apiDomainName = `${domainConfig.apiSubdomain}.${domainConfig.zoneName}`;

    // Create ACM certificate for the auth API domain
    this.certificate = new acm.Certificate(this, 'AuthApiCertificate', {
      domainName: this.apiDomainName,
      certificateName: `game-auth-api-${environment}`,
      validation: acm.CertificateValidation.fromDns(this.hostedZone)
    });

    // Create custom domain for API Gateway
    const apiDomain = new apigateway.DomainName(this, 'AuthApiDomain', {
      domainName: this.apiDomainName,
      certificate: this.certificate,
      endpointType: apigateway.EndpointType.REGIONAL,
      securityPolicy: apigateway.SecurityPolicy.TLS_1_2
    });

    // Map custom domain to API Gateway
    new apigateway.BasePathMapping(this, 'AuthApiMapping', {
      domainName: apiDomain,
      restApi: authApi
    });

    // Create Route53 A record for the API
    new route53.ARecord(this, 'AuthApiARecord', {
      zone: this.hostedZone,
      recordName: domainConfig.apiSubdomain,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.ApiGatewayDomain(apiDomain)
      ),
      comment: `Auth API endpoint for ${environment} environment`
    });

    // Output the API endpoint
    new cdk.CfnOutput(this, 'AuthApiUrl', {
      value: `https://${this.apiDomainName}`,
      description: 'Authentication API URL with custom domain'
    });

    // Output NS servers for delegation (only needed during initial setup)
    new cdk.CfnOutput(this, 'NameServers', {
      value: cdk.Fn.join(',', this.hostedZone.hostedZoneNameServers || []),
      description: 'NS records to add in Ops account for delegation'
    });
  }
}