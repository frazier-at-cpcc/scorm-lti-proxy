import { query } from '../db/index.js';
import { config } from '../config.js';

interface XapiStatementData {
  verb: 'launched' | 'completed' | 'progressed' | 'passed' | 'failed' | 'scored';
  score?: number | null;
  success?: boolean;
  duration?: string;
}

interface XapiStatement {
  actor: {
    objectType: 'Agent';
    account: {
      homePage: string;
      name: string;
    };
  };
  verb: {
    id: string;
    display: { 'en-US': string };
  };
  object: {
    objectType: 'Activity';
    id: string;
    definition: {
      type: string;
      name: { 'en-US': string };
    };
  };
  result?: {
    score?: {
      scaled: number;
      raw?: number;
      min?: number;
      max?: number;
    };
    success?: boolean;
    completion?: boolean;
    duration?: string;
  };
  timestamp: string;
}

// xAPI verb URIs (ADL vocabulary)
const VERBS: Record<string, { id: string; display: string }> = {
  launched: {
    id: 'http://adlnet.gov/expapi/verbs/launched',
    display: 'launched',
  },
  completed: {
    id: 'http://adlnet.gov/expapi/verbs/completed',
    display: 'completed',
  },
  progressed: {
    id: 'http://adlnet.gov/expapi/verbs/progressed',
    display: 'progressed',
  },
  passed: {
    id: 'http://adlnet.gov/expapi/verbs/passed',
    display: 'passed',
  },
  failed: {
    id: 'http://adlnet.gov/expapi/verbs/failed',
    display: 'failed',
  },
  scored: {
    id: 'http://adlnet.gov/expapi/verbs/scored',
    display: 'scored',
  },
};

/**
 * Sends an xAPI statement to the configured LRS
 */
export async function sendXapiStatement(
  consumerId: string,
  userId: string,
  courseId: string,
  data: XapiStatementData
): Promise<void> {
  // Get consumer's LRS config (or fall back to global config)
  const consumerResult = await query<{
    xapi_lrs_endpoint: string | null;
    xapi_lrs_key: string | null;
    xapi_lrs_secret: string | null;
  }>(
    'SELECT xapi_lrs_endpoint, xapi_lrs_key, xapi_lrs_secret FROM consumers WHERE id = $1',
    [consumerId]
  );

  let lrsEndpoint = config.xapi.endpoint;
  let lrsKey = config.xapi.key;
  let lrsSecret = config.xapi.secret;

  if (consumerResult.rows.length > 0) {
    const consumer = consumerResult.rows[0];
    if (consumer.xapi_lrs_endpoint) {
      lrsEndpoint = consumer.xapi_lrs_endpoint;
      lrsKey = consumer.xapi_lrs_key || '';
      lrsSecret = consumer.xapi_lrs_secret || '';
    }
  }

  if (!lrsEndpoint) {
    console.log('No LRS configured, skipping xAPI statement');
    return;
  }

  // Get course info for activity
  const courseResult = await query<{ title: string }>(
    'SELECT title FROM courses WHERE id = $1',
    [courseId]
  );

  const courseTitle = courseResult.rows[0]?.title || 'Unknown Course';

  // Build xAPI statement
  const statement = buildStatement(userId, courseId, courseTitle, data);

  // Send to LRS
  const statementsUrl = `${lrsEndpoint.replace(/\/$/, '')}/statements`;

  const response = await fetch(statementsUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${lrsKey}:${lrsSecret}`).toString('base64')}`,
      'X-Experience-API-Version': '1.0.3',
    },
    body: JSON.stringify(statement),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`xAPI statement failed: ${response.status} - ${errorText}`);
  }

  console.log(`xAPI statement sent: ${data.verb} for user ${userId}`);
}

/**
 * Builds an xAPI statement
 */
function buildStatement(
  userId: string,
  courseId: string,
  courseTitle: string,
  data: XapiStatementData
): XapiStatement {
  const verb = VERBS[data.verb];

  const statement: XapiStatement = {
    actor: {
      objectType: 'Agent',
      account: {
        homePage: config.baseUrl,
        name: userId,
      },
    },
    verb: {
      id: verb.id,
      display: { 'en-US': verb.display },
    },
    object: {
      objectType: 'Activity',
      id: `${config.baseUrl}/course/${courseId}`,
      definition: {
        type: 'http://adlnet.gov/expapi/activities/course',
        name: { 'en-US': courseTitle },
      },
    },
    timestamp: new Date().toISOString(),
  };

  // Add result if applicable
  if (data.score !== undefined && data.score !== null) {
    statement.result = {
      score: {
        scaled: data.score,
        raw: Math.round(data.score * 100),
        min: 0,
        max: 100,
      },
    };
  }

  if (data.success !== undefined) {
    statement.result = statement.result || {};
    statement.result.success = data.success;
  }

  if (data.verb === 'completed') {
    statement.result = statement.result || {};
    statement.result.completion = true;
  }

  if (data.duration) {
    statement.result = statement.result || {};
    statement.result.duration = data.duration;
  }

  return statement;
}

/**
 * Queries the LRS for statements about a specific user and course
 */
export async function getXapiStatements(
  consumerId: string,
  userId: string,
  courseId: string
): Promise<XapiStatement[]> {
  // Get consumer's LRS config
  const consumerResult = await query<{
    xapi_lrs_endpoint: string | null;
    xapi_lrs_key: string | null;
    xapi_lrs_secret: string | null;
  }>(
    'SELECT xapi_lrs_endpoint, xapi_lrs_key, xapi_lrs_secret FROM consumers WHERE id = $1',
    [consumerId]
  );

  let lrsEndpoint = config.xapi.endpoint;
  let lrsKey = config.xapi.key;
  let lrsSecret = config.xapi.secret;

  if (consumerResult.rows.length > 0) {
    const consumer = consumerResult.rows[0];
    if (consumer.xapi_lrs_endpoint) {
      lrsEndpoint = consumer.xapi_lrs_endpoint;
      lrsKey = consumer.xapi_lrs_key || '';
      lrsSecret = consumer.xapi_lrs_secret || '';
    }
  }

  if (!lrsEndpoint) {
    return [];
  }

  const activityId = encodeURIComponent(`${config.baseUrl}/course/${courseId}`);
  const agentJson = encodeURIComponent(
    JSON.stringify({
      account: { homePage: config.baseUrl, name: userId },
    })
  );

  const queryUrl = `${lrsEndpoint.replace(/\/$/, '')}/statements?activity=${activityId}&agent=${agentJson}`;

  const response = await fetch(queryUrl, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${Buffer.from(`${lrsKey}:${lrsSecret}`).toString('base64')}`,
      'X-Experience-API-Version': '1.0.3',
    },
  });

  if (!response.ok) {
    throw new Error(`xAPI query failed: ${response.status}`);
  }

  const result = (await response.json()) as { statements: XapiStatement[] };
  return result.statements || [];
}
