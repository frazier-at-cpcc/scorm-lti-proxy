import { Router, Request, Response } from 'express';
import { config } from '../config.js';
import { query } from '../db/index.js';
import { validateLtiLaunch, LtiLaunchData } from '../services/lti-provider.js';
import { v4 as uuidv4 } from 'uuid';

export const ltiRouter = Router();

// LTI 1.1 Launch endpoint
ltiRouter.post('/launch', async (req: Request, res: Response) => {
  try {
    const launchData = req.body as Record<string, string>;

    // Get consumer key from launch
    const consumerKey = launchData.oauth_consumer_key;
    if (!consumerKey) {
      return res.status(400).send('Missing oauth_consumer_key');
    }

    // Look up consumer
    const consumerResult = await query<{
      id: string;
      lti_consumer_secret: string;
    }>(
      'SELECT id, lti_consumer_secret FROM consumers WHERE lti_consumer_key = $1 AND active = true',
      [consumerKey]
    );

    if (consumerResult.rows.length === 0) {
      return res.status(401).send('Unknown consumer');
    }

    const consumer = consumerResult.rows[0];

    // Validate OAuth signature
    const fullUrl = `${config.baseUrl}/lti/launch`;
    const isValid = validateLtiLaunch(
      launchData,
      consumer.lti_consumer_secret,
      fullUrl
    );

    if (!isValid) {
      return res.status(401).send('Invalid OAuth signature');
    }

    // Extract LTI parameters
    const ltiData: LtiLaunchData = {
      userId: launchData.user_id || launchData.lis_person_sourcedid || 'anonymous',
      contextId: launchData.context_id,
      resourceLinkId: launchData.resource_link_id,
      lisOutcomeServiceUrl: launchData.lis_outcome_service_url,
      lisResultSourcedid: launchData.lis_result_sourcedid,
      customCourseId: launchData.custom_course_id,
    };

    // Get course (from custom parameter or default)
    let courseId = ltiData.customCourseId;
    if (!courseId) {
      // Get first active course as default (for testing)
      const courseResult = await query<{ id: string }>(
        'SELECT id FROM courses WHERE active = true LIMIT 1'
      );
      if (courseResult.rows.length === 0) {
        return res.status(404).send('No courses available');
      }
      courseId = courseResult.rows[0].id;
    }

    // Create launch record
    const launchId = uuidv4();
    await query(
      `INSERT INTO launches (id, consumer_id, course_id, user_id, context_id, resource_link_id,
        lis_outcome_service_url, lis_result_sourcedid, launch_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        launchId,
        consumer.id,
        courseId,
        ltiData.userId,
        ltiData.contextId,
        ltiData.resourceLinkId,
        ltiData.lisOutcomeServiceUrl,
        ltiData.lisResultSourcedid,
        JSON.stringify(launchData),
      ]
    );

    // Create or resume attempt
    const existingAttempt = await query<{ id: string }>(
      `SELECT a.id FROM attempts a
       JOIN launches l ON a.launch_id = l.id
       WHERE l.user_id = $1 AND l.course_id = $2 AND a.finished_at IS NULL
       ORDER BY a.started_at DESC LIMIT 1`,
      [ltiData.userId, courseId]
    );

    let attemptId: string;
    if (existingAttempt.rows.length > 0) {
      attemptId = existingAttempt.rows[0].id;
    } else {
      attemptId = uuidv4();
      await query(
        'INSERT INTO attempts (id, launch_id) VALUES ($1, $2)',
        [attemptId, launchId]
      );
    }

    // Redirect to SCORM player
    const playerUrl = `${config.baseUrl}/static/player.html?attemptId=${attemptId}&courseId=${courseId}`;
    res.redirect(playerUrl);
  } catch (error) {
    console.error('LTI launch error:', error);
    res.status(500).send('Launch failed');
  }
});

// LTI configuration endpoint (for LMS setup)
ltiRouter.get('/config', (_req: Request, res: Response) => {
  res.json({
    title: 'SCORM-LTI Proxy',
    description: 'Host SCORM content with LTI grade passback',
    launchUrl: `${config.baseUrl}/lti/launch`,
    icon: `${config.baseUrl}/static/icon.png`,
    customParameters: {
      course_id: 'The UUID of the course to launch',
    },
  });
});
