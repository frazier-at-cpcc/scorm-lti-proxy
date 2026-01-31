import { query } from '../db/index.js';
import { signRequest, generateOAuthParams } from './lti-provider.js';

/**
 * Sends a grade back to the LMS via LTI 1.1 Basic Outcomes Service
 * Uses POX (Plain Old XML) format as per LTI 1.1 spec
 */
export async function sendGradeToLms(
  consumerId: string,
  outcomeServiceUrl: string,
  sourcedid: string,
  score: number // 0.0 to 1.0
): Promise<void> {
  // Get consumer credentials
  const consumerResult = await query<{
    lti_consumer_key: string;
    lti_consumer_secret: string;
  }>(
    'SELECT lti_consumer_key, lti_consumer_secret FROM consumers WHERE id = $1',
    [consumerId]
  );

  if (consumerResult.rows.length === 0) {
    throw new Error('Consumer not found');
  }

  const consumer = consumerResult.rows[0];

  // Build POX XML body for replaceResult
  const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const xmlBody = buildReplaceResultXml(sourcedid, score, messageId);

  // Generate OAuth parameters
  const oauthParams = generateOAuthParams(consumer.lti_consumer_key);
  oauthParams.oauth_body_hash = computeBodyHash(xmlBody);

  // Sign the request
  const signature = signRequest(
    'POST',
    outcomeServiceUrl,
    oauthParams,
    consumer.lti_consumer_secret
  );

  oauthParams.oauth_signature = signature;

  // Build Authorization header
  const authHeader = buildAuthHeader(oauthParams);

  // Send the request
  const response = await fetch(outcomeServiceUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/xml',
      Authorization: authHeader,
    },
    body: xmlBody,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Grade passback failed: ${response.status} - ${errorText}`);
  }

  const responseXml = await response.text();

  // Check for success in response
  if (!responseXml.includes('<imsx_codeMajor>success</imsx_codeMajor>')) {
    throw new Error(`Grade passback rejected: ${responseXml}`);
  }

  console.log(`Grade ${score} sent successfully for sourcedid: ${sourcedid}`);
}

/**
 * Builds the POX XML for replaceResult operation
 */
function buildReplaceResultXml(
  sourcedid: string,
  score: number,
  messageId: string
): string {
  // Clamp score to 0-1 range
  const clampedScore = Math.max(0, Math.min(1, score));

  return `<?xml version="1.0" encoding="UTF-8"?>
<imsx_POXEnvelopeRequest xmlns="http://www.imsglobal.org/services/ltiv1p1/xsd/imsoms_v1p0">
  <imsx_POXHeader>
    <imsx_POXRequestHeaderInfo>
      <imsx_version>V1.0</imsx_version>
      <imsx_messageIdentifier>${escapeXml(messageId)}</imsx_messageIdentifier>
    </imsx_POXRequestHeaderInfo>
  </imsx_POXHeader>
  <imsx_POXBody>
    <replaceResultRequest>
      <resultRecord>
        <sourcedGUID>
          <sourcedId>${escapeXml(sourcedid)}</sourcedId>
        </sourcedGUID>
        <result>
          <resultScore>
            <language>en</language>
            <textString>${clampedScore.toFixed(2)}</textString>
          </resultScore>
        </result>
      </resultRecord>
    </replaceResultRequest>
  </imsx_POXBody>
</imsx_POXEnvelopeRequest>`;
}

/**
 * Computes SHA-1 hash of body for oauth_body_hash
 */
function computeBodyHash(body: string): string {
  const crypto = require('crypto');
  return crypto.createHash('sha1').update(body).digest('base64');
}

/**
 * Builds OAuth Authorization header
 */
function buildAuthHeader(params: Record<string, string>): string {
  const pairs = Object.entries(params)
    .filter(([key]) => key.startsWith('oauth_'))
    .map(([key, value]) => `${encodeRfc3986(key)}="${encodeRfc3986(value)}"`)
    .join(', ');

  return `OAuth ${pairs}`;
}

/**
 * RFC 3986 encoding
 */
function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

/**
 * Escape special XML characters
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
