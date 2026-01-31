import crypto from 'crypto';

export interface LtiLaunchData {
  userId: string;
  contextId?: string;
  resourceLinkId?: string;
  lisOutcomeServiceUrl?: string;
  lisResultSourcedid?: string;
  customCourseId?: string;
}

/**
 * Validates an LTI 1.1 OAuth signature
 */
export function validateLtiLaunch(
  params: Record<string, string>,
  consumerSecret: string,
  url: string
): boolean {
  const signature = params.oauth_signature;
  if (!signature) {
    return false;
  }

  // Build base string for signature
  const baseString = buildBaseString('POST', url, params);

  // Calculate expected signature
  // Token secret is empty for LTI 1.1
  const signingKey = `${encodeURIComponent(consumerSecret)}&`;
  const expectedSignature = crypto
    .createHmac('sha1', signingKey)
    .update(baseString)
    .digest('base64');

  // Compare signatures (timing-safe)
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch {
    return false;
  }
}

/**
 * Builds OAuth base string for signature calculation
 */
function buildBaseString(
  method: string,
  url: string,
  params: Record<string, string>
): string {
  // Remove oauth_signature from params
  const filteredParams = { ...params };
  delete filteredParams.oauth_signature;

  // Sort parameters alphabetically
  const sortedKeys = Object.keys(filteredParams).sort();
  const paramString = sortedKeys
    .map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(filteredParams[key])}`)
    .join('&');

  // Build base string
  return [
    method.toUpperCase(),
    encodeRfc3986(normalizeUrl(url)),
    encodeRfc3986(paramString),
  ].join('&');
}

/**
 * RFC 3986 percent-encoding
 */
function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

/**
 * Normalizes URL for OAuth signature (removes port for standard ports)
 */
function normalizeUrl(url: string): string {
  const parsed = new URL(url);

  // Remove default ports
  if (
    (parsed.protocol === 'http:' && parsed.port === '80') ||
    (parsed.protocol === 'https:' && parsed.port === '443')
  ) {
    parsed.port = '';
  }

  // Return URL without query string or fragment
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

/**
 * Generates OAuth parameters for signing a request
 */
export function generateOAuthParams(consumerKey: string): Record<string, string> {
  return {
    oauth_consumer_key: consumerKey,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_version: '1.0',
  };
}

/**
 * Signs a request with OAuth 1.0a
 */
export function signRequest(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string
): string {
  const baseString = buildBaseString(method, url, params);
  const signingKey = `${encodeURIComponent(consumerSecret)}&`;

  return crypto
    .createHmac('sha1', signingKey)
    .update(baseString)
    .digest('base64');
}
