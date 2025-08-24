import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import * as crypto from 'crypto';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const sesClient = new SESClient({});

const RISK_ASSESSMENT_TABLE = process.env.RISK_ASSESSMENT_TABLE!;
const TRUSTED_DEVICES_TABLE = process.env.TRUSTED_DEVICES_TABLE!;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@loupeen.com';
const ENVIRONMENT = process.env.ENVIRONMENT!;

interface RiskAssessmentRequest {
  userId: string;
  action: 'assess' | 'history' | 'alert';
  sessionData?: {
    ipAddress: string;
    userAgent: string;
    deviceFingerprint?: string;
    location?: string;
    timestamp?: string;
  };
  timeRange?: {
    start: string;
    end: string;
  };
}

interface RiskFactors {
  impossibleTravel: number;
  newDevice: number;
  unusualTime: number;
  suspiciousIP: number;
  velocityRisk: number;
  behavioralAnomaly: number;
  geolocationRisk: number;
}

interface RiskAssessment {
  userId: string;
  sessionId: string;
  timestamp: string;
  overallRiskScore: number;
  riskFactors: RiskFactors;
  triggeredRules: string[];
  recommendedAction: 'allow' | 'challenge' | 'block';
  metadata: any;
}

/**
 * Handler for risk assessment and anomaly detection
 * Analyzes user behavior patterns to detect suspicious activity
 */
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log('Risk Assessment Request:', JSON.stringify(event, null, 2));

  try {
    const request: RiskAssessmentRequest = JSON.parse(event.body || '{}');
    const { userId, action, sessionData, timeRange } = request;

    if (!userId || !action) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          message: 'User ID and action are required'
        })
      };
    }

    switch (action) {
      case 'assess':
        if (!sessionData) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              success: false,
              message: 'Session data is required for risk assessment'
            })
          };
        }

        const assessment = await performRiskAssessment(userId, sessionData);
        
        // Store assessment for future analysis
        await storeRiskAssessment(assessment);
        
        // Trigger alerts if high risk
        if (assessment.overallRiskScore > 0.8) {
          await triggerSecurityAlert(userId, assessment);
        }

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: true,
            assessment,
            message: 'Risk assessment completed'
          })
        };

      case 'history':
        const history = await getRiskHistory(userId, timeRange);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: true,
            history,
            count: history.length
          })
        };

      case 'alert':
        const recentHighRisk = await getRecentHighRiskSessions(userId);
        if (recentHighRisk.length > 0) {
          await triggerSecurityAlert(userId, recentHighRisk[0]);
        }
        
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: true,
            alertTriggered: recentHighRisk.length > 0,
            message: recentHighRisk.length > 0 
              ? 'Security alert triggered' 
              : 'No high-risk sessions found'
          })
        };

      default:
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: false,
            message: 'Invalid action. Supported actions: assess, history, alert'
          })
        };
    }
  } catch (error) {
    console.error('Risk assessment error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        message: 'Failed to process risk assessment request'
      })
    };
  }
};

/**
 * Perform comprehensive risk assessment
 */
async function performRiskAssessment(userId: string, sessionData: any): Promise<RiskAssessment> {
  const sessionId = generateSessionId();
  const timestamp = new Date().toISOString();
  
  const riskFactors: RiskFactors = {
    impossibleTravel: 0,
    newDevice: 0,
    unusualTime: 0,
    suspiciousIP: 0,
    velocityRisk: 0,
    behavioralAnomaly: 0,
    geolocationRisk: 0
  };

  const triggeredRules: string[] = [];

  // 1. Impossible Travel Detection
  const impossibleTravelScore = await assessImpossibleTravel(userId, sessionData);
  riskFactors.impossibleTravel = impossibleTravelScore;
  if (impossibleTravelScore > 0.7) {
    triggeredRules.push('IMPOSSIBLE_TRAVEL');
  }

  // 2. New Device Detection
  const newDeviceScore = await assessNewDevice(userId, sessionData);
  riskFactors.newDevice = newDeviceScore;
  if (newDeviceScore > 0.5) {
    triggeredRules.push('NEW_DEVICE');
  }

  // 3. Unusual Time Analysis
  const unusualTimeScore = assessUnusualTime(sessionData);
  riskFactors.unusualTime = unusualTimeScore;
  if (unusualTimeScore > 0.6) {
    triggeredRules.push('UNUSUAL_TIME');
  }

  // 4. IP Address Analysis
  const suspiciousIPScore = await assessSuspiciousIP(sessionData.ipAddress);
  riskFactors.suspiciousIP = suspiciousIPScore;
  if (suspiciousIPScore > 0.7) {
    triggeredRules.push('SUSPICIOUS_IP');
  }

  // 5. Velocity Risk (too many requests)
  const velocityScore = await assessVelocityRisk(userId);
  riskFactors.velocityRisk = velocityScore;
  if (velocityScore > 0.8) {
    triggeredRules.push('HIGH_VELOCITY');
  }

  // 6. Behavioral Anomaly Detection
  const behavioralScore = await assessBehavioralAnomaly(userId, sessionData);
  riskFactors.behavioralAnomaly = behavioralScore;
  if (behavioralScore > 0.6) {
    triggeredRules.push('BEHAVIORAL_ANOMALY');
  }

  // 7. Geolocation Risk
  const geolocationScore = await assessGeolocationRisk(sessionData.location);
  riskFactors.geolocationRisk = geolocationScore;
  if (geolocationScore > 0.5) {
    triggeredRules.push('HIGH_RISK_LOCATION');
  }

  // Calculate overall risk score (weighted average)
  const weights = {
    impossibleTravel: 0.25,
    newDevice: 0.15,
    unusualTime: 0.10,
    suspiciousIP: 0.20,
    velocityRisk: 0.15,
    behavioralAnomaly: 0.10,
    geolocationRisk: 0.05
  };

  const overallRiskScore = Object.entries(riskFactors).reduce((total, [factor, score]) => {
    return total + (score * (weights[factor as keyof typeof weights] || 0));
  }, 0);

  // Determine recommended action
  let recommendedAction: 'allow' | 'challenge' | 'block' = 'allow';
  if (overallRiskScore > 0.8) {
    recommendedAction = 'block';
  } else if (overallRiskScore > 0.4) {
    recommendedAction = 'challenge';
  }

  return {
    userId,
    sessionId,
    timestamp,
    overallRiskScore: Math.min(overallRiskScore, 1.0),
    riskFactors,
    triggeredRules,
    recommendedAction,
    metadata: sessionData
  };
}

/**
 * Assess impossible travel (location change too quickly)
 */
async function assessImpossibleTravel(userId: string, sessionData: any): Promise<number> {
  try {
    // Get user's last known location and timestamp
    const lastSession = await getLastSession(userId);
    
    if (!lastSession || !sessionData.location || !lastSession.metadata?.location) {
      return 0.1; // Low risk if no location data
    }

    const timeDiff = new Date(sessionData.timestamp || Date.now()).getTime() - 
                     new Date(lastSession.timestamp).getTime();
    const timeHours = timeDiff / (1000 * 60 * 60);

    if (timeHours < 0.5) { // Less than 30 minutes
      const distance = calculateDistance(
        lastSession.metadata.location,
        sessionData.location
      );

      // If traveled more than 500km in less than 30 minutes
      if (distance > 500) {
        return 0.9; // Very high risk
      }

      // If traveled more than 100km in less than 30 minutes
      if (distance > 100) {
        return 0.6; // Medium-high risk
      }
    }

    return 0.1; // Low risk
  } catch (error) {
    console.error('Error assessing impossible travel:', error);
    return 0.3; // Default medium-low risk on error
  }
}

/**
 * Assess if device is new/unknown
 */
async function assessNewDevice(userId: string, sessionData: any): Promise<number> {
  try {
    if (!sessionData.deviceFingerprint) {
      return 0.4; // Medium risk for missing fingerprint
    }

    // Check if device is in trusted devices table
    const command = new QueryCommand({
      TableName: TRUSTED_DEVICES_TABLE,
      KeyConditionExpression: 'userId = :userId',
      FilterExpression: 'deviceFingerprint = :fingerprint',
      ExpressionAttributeValues: {
        ':userId': userId,
        ':fingerprint': sessionData.deviceFingerprint
      }
    });

    const response = await docClient.send(command);
    
    if (response.Items && response.Items.length > 0) {
      // Known device, check trust level
      const device = response.Items[0];
      if (device.trusted) {
        return 0.1; // Low risk for trusted device
      }
      return 0.3; // Medium-low risk for known but untrusted device
    }

    // New device
    return 0.7; // High risk for completely new device
  } catch (error) {
    console.error('Error assessing new device:', error);
    return 0.5; // Default medium risk on error
  }
}

/**
 * Assess unusual time patterns
 */
function assessUnusualTime(sessionData: any): number {
  const timestamp = new Date(sessionData.timestamp || Date.now());
  const hour = timestamp.getHours();
  const day = timestamp.getDay(); // 0 = Sunday

  // High risk hours (2 AM - 5 AM)
  if (hour >= 2 && hour <= 5) {
    return 0.7;
  }

  // Medium risk hours (11 PM - 1 AM, 6 AM - 7 AM)
  if ((hour >= 23 || hour <= 1) || (hour >= 6 && hour <= 7)) {
    return 0.4;
  }

  // Weekend activity might be more flexible
  if (day === 0 || day === 6) { // Sunday or Saturday
    return 0.1;
  }

  // Normal business/gaming hours
  return 0.1;
}

/**
 * Assess suspicious IP characteristics
 */
async function assessSuspiciousIP(ipAddress: string): Promise<number> {
  try {
    let riskScore = 0;

    // Check if IP is from Tor network (high risk)
    if (await isTorIP(ipAddress)) {
      riskScore += 0.8;
    }

    // Check if IP is from known VPN provider (medium risk)
    if (await isVPNIP(ipAddress)) {
      riskScore += 0.4;
    }

    // Check if IP is from proxy service (medium risk)
    if (await isProxyIP(ipAddress)) {
      riskScore += 0.4;
    }

    // Check IP reputation (varies)
    const reputationScore = await checkIPReputation(ipAddress);
    riskScore += reputationScore;

    // Check if IP is from high-risk country
    const countryRisk = await assessCountryRisk(ipAddress);
    riskScore += countryRisk;

    return Math.min(riskScore, 1.0);
  } catch (error) {
    console.error('Error assessing suspicious IP:', error);
    return 0.3; // Default medium-low risk on error
  }
}

/**
 * Assess velocity risk (too many requests in short time)
 */
async function assessVelocityRisk(userId: string): Promise<number> {
  try {
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    // Count sessions in last 5 minutes
    const recentSessions = await getRiskHistory(userId, {
      start: fiveMinutesAgo.toISOString(),
      end: now.toISOString()
    });

    // Count sessions in last hour
    const hourlySessions = await getRiskHistory(userId, {
      start: oneHourAgo.toISOString(),
      end: now.toISOString()
    });

    let riskScore = 0;

    // More than 10 sessions in 5 minutes is very suspicious
    if (recentSessions.length > 10) {
      riskScore += 0.9;
    } else if (recentSessions.length > 5) {
      riskScore += 0.6;
    }

    // More than 50 sessions in 1 hour is suspicious
    if (hourlySessions.length > 50) {
      riskScore += 0.7;
    } else if (hourlySessions.length > 30) {
      riskScore += 0.4;
    }

    return Math.min(riskScore, 1.0);
  } catch (error) {
    console.error('Error assessing velocity risk:', error);
    return 0.2; // Default low risk on error
  }
}

/**
 * Assess behavioral anomalies
 */
async function assessBehavioralAnomaly(userId: string, sessionData: any): Promise<number> {
  try {
    // Get user's historical behavior patterns
    const history = await getRiskHistory(userId, {
      start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
      end: new Date().toISOString()
    });

    if (history.length < 10) {
      return 0.2; // Not enough data for behavioral analysis
    }

    let anomalyScore = 0;

    // Analyze user agent patterns
    const userAgents = history.map(h => h.metadata?.userAgent).filter(Boolean);
    const currentUserAgent = sessionData.userAgent;
    
    if (currentUserAgent && !userAgents.includes(currentUserAgent)) {
      anomalyScore += 0.3; // New user agent
    }

    // Analyze IP address patterns
    const ipAddresses = history.map(h => h.metadata?.ipAddress).filter(Boolean);
    const currentIP = sessionData.ipAddress;
    
    if (currentIP && !ipAddresses.includes(currentIP)) {
      anomalyScore += 0.2; // New IP address
    }

    // Analyze timing patterns
    const sessionHours = history.map(h => new Date(h.timestamp).getHours());
    const currentHour = new Date(sessionData.timestamp || Date.now()).getHours();
    
    const hourFreq = sessionHours.reduce((acc, hour) => {
      acc[hour] = (acc[hour] || 0) + 1;
      return acc;
    }, {} as Record<number, number>);

    if ((hourFreq[currentHour] || 0) < 2) {
      anomalyScore += 0.2; // Unusual hour for this user
    }

    return Math.min(anomalyScore, 1.0);
  } catch (error) {
    console.error('Error assessing behavioral anomaly:', error);
    return 0.3; // Default medium-low risk on error
  }
}

/**
 * Assess geolocation-based risk
 */
async function assessGeolocationRisk(location?: string): Promise<number> {
  if (!location) {
    return 0.3; // Medium-low risk for unknown location
  }

  const highRiskCountries = [
    'Anonymous Proxy',
    'Satellite Provider',
    'Other'
  ];

  const mediumRiskCountries = [
    // Countries with higher fraud rates
    'Nigeria', 'Ghana', 'Indonesia', 'Philippines'
  ];

  if (highRiskCountries.some(country => location.includes(country))) {
    return 0.8; // High risk
  }

  if (mediumRiskCountries.some(country => location.includes(country))) {
    return 0.4; // Medium risk
  }

  return 0.1; // Low risk for most locations
}

/**
 * Store risk assessment result
 */
async function storeRiskAssessment(assessment: RiskAssessment): Promise<void> {
  const command = new PutCommand({
    TableName: RISK_ASSESSMENT_TABLE,
    Item: {
      ...assessment,
      // Add GSI key for querying by risk score
      riskScoreIndex: `${assessment.userId}#${assessment.overallRiskScore.toFixed(2)}`
    }
  });

  await docClient.send(command);
}

/**
 * Get risk history for a user
 */
async function getRiskHistory(userId: string, timeRange?: { start: string; end: string }): Promise<RiskAssessment[]> {
  const commandInput: any = {
    TableName: RISK_ASSESSMENT_TABLE,
    KeyConditionExpression: 'userId = :userId',
    ExpressionAttributeValues: {
      ':userId': userId
    },
    ScanIndexForward: false, // Get most recent first
    Limit: 100
  };

  if (timeRange) {
    commandInput.FilterExpression = '#timestamp BETWEEN :start AND :end';
    commandInput.ExpressionAttributeNames = { '#timestamp': 'timestamp' };
    commandInput.ExpressionAttributeValues = {
      ...commandInput.ExpressionAttributeValues,
      ':start': timeRange.start,
      ':end': timeRange.end
    };
  }

  const command = new QueryCommand(commandInput);

  const response = await docClient.send(command);
  return (response.Items as RiskAssessment[]) || [];
}

/**
 * Get last session for a user
 */
async function getLastSession(userId: string): Promise<RiskAssessment | null> {
  const history = await getRiskHistory(userId);
  return history.length > 0 ? history[0] : null;
}

/**
 * Get recent high-risk sessions
 */
async function getRecentHighRiskSessions(userId: string): Promise<RiskAssessment[]> {
  const history = await getRiskHistory(userId);
  return history.filter(session => session.overallRiskScore > 0.7);
}

/**
 * Trigger security alert for high-risk activity
 */
async function triggerSecurityAlert(userId: string, assessment: RiskAssessment): Promise<void> {
  try {
    const subject = `🚨 High-Risk Activity Detected - User: ${userId}`;
    const body = `
High-risk activity detected for user ${userId}:

Risk Score: ${(assessment.overallRiskScore * 100).toFixed(1)}%
Recommended Action: ${assessment.recommendedAction.toUpperCase()}

Risk Factors:
- Impossible Travel: ${(assessment.riskFactors.impossibleTravel * 100).toFixed(1)}%
- New Device: ${(assessment.riskFactors.newDevice * 100).toFixed(1)}%
- Suspicious IP: ${(assessment.riskFactors.suspiciousIP * 100).toFixed(1)}%
- High Velocity: ${(assessment.riskFactors.velocityRisk * 100).toFixed(1)}%

Triggered Rules: ${assessment.triggeredRules.join(', ')}

Session Details:
- Timestamp: ${assessment.timestamp}
- IP Address: ${assessment.metadata.ipAddress}
- User Agent: ${assessment.metadata.userAgent}
- Location: ${assessment.metadata.location || 'Unknown'}

Please investigate immediately.

Environment: ${ENVIRONMENT}
Session ID: ${assessment.sessionId}
`;

    const command = new SendEmailCommand({
      Source: ADMIN_EMAIL,
      Destination: {
        ToAddresses: [ADMIN_EMAIL]
      },
      Message: {
        Subject: {
          Data: subject,
          Charset: 'UTF-8'
        },
        Body: {
          Text: {
            Data: body,
            Charset: 'UTF-8'
          }
        }
      }
    });

    await sesClient.send(command);
    
    console.log(`Security alert sent for user ${userId}`, {
      riskScore: assessment.overallRiskScore,
      triggeredRules: assessment.triggeredRules
    });
  } catch (error) {
    console.error('Error sending security alert:', error);
  }
}

// Helper functions for IP analysis (simplified implementations)
async function isTorIP(ipAddress: string): Promise<boolean> {
  // In production, integrate with Tor exit node lists
  return false;
}

async function isVPNIP(ipAddress: string): Promise<boolean> {
  // In production, integrate with VPN detection services
  return false;
}

async function isProxyIP(ipAddress: string): Promise<boolean> {
  // In production, integrate with proxy detection services
  return false;
}

async function checkIPReputation(ipAddress: string): Promise<number> {
  // In production, integrate with IP reputation services
  return 0.1; // Default low risk
}

async function assessCountryRisk(ipAddress: string): Promise<number> {
  // In production, use GeoIP lookup and country risk databases
  return 0.1; // Default low risk
}

function calculateDistance(location1: string, location2: string): number {
  // Simplified distance calculation
  // In production, use proper geospatial calculations
  if (location1 === location2) return 0;
  return Math.random() * 1000; // Random distance for demo
}

function generateSessionId(): string {
  return crypto.randomBytes(16).toString('hex');
}