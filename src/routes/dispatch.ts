import { Router, Request, Response } from 'express';
import { config } from '../config.js';
import { query } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';

export const dispatchRouter = Router();

// Dispatch launch endpoint (called by thin SCORM package)
dispatchRouter.get('/launch/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const { user_id, session_id } = req.query;

    // Validate dispatch token
    const tokenResult = await query<{
      id: string;
      consumer_id: string;
      course_id: string;
    }>(
      `SELECT dt.id, dt.consumer_id, dt.course_id
       FROM dispatch_tokens dt
       WHERE dt.token = $1 AND dt.active = true`,
      [token]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(404).send('Invalid or expired dispatch token');
    }

    const dispatchToken = tokenResult.rows[0];

    // Get course info
    const courseResult = await query<{ id: string; launch_path: string }>(
      'SELECT id, launch_path FROM courses WHERE id = $1 AND active = true',
      [dispatchToken.course_id]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).send('Course not found');
    }

    // Create launch record for dispatch
    const launchId = uuidv4();
    const userId = (user_id as string) || session_id || `dispatch_${uuidv4()}`;

    await query(
      `INSERT INTO launches (id, consumer_id, course_id, user_id, launch_data)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        launchId,
        dispatchToken.consumer_id,
        dispatchToken.course_id,
        userId,
        JSON.stringify({ type: 'dispatch', token, query: req.query }),
      ]
    );

    // Create attempt
    const attemptId = uuidv4();
    await query(
      'INSERT INTO attempts (id, launch_id) VALUES ($1, $2)',
      [attemptId, launchId]
    );

    // Redirect to SCORM player
    const playerUrl = `${config.baseUrl}/static/player.html?attemptId=${attemptId}&courseId=${dispatchToken.course_id}&mode=dispatch`;
    res.redirect(playerUrl);
  } catch (error) {
    console.error('Dispatch launch error:', error);
    res.status(500).send('Launch failed');
  }
});

// Generate dispatch package info
dispatchRouter.get('/package/:courseId', async (req: Request, res: Response) => {
  try {
    const { courseId } = req.params;
    const { consumerId } = req.query;

    if (!consumerId) {
      return res.status(400).json({ error: 'consumerId required' });
    }

    // Verify course exists
    const courseResult = await query<{ id: string; title: string }>(
      'SELECT id, title FROM courses WHERE id = $1 AND active = true',
      [courseId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({ error: 'Course not found' });
    }

    // Create or get existing dispatch token
    let tokenResult = await query<{ token: string }>(
      `SELECT token FROM dispatch_tokens
       WHERE consumer_id = $1 AND course_id = $2 AND active = true`,
      [consumerId, courseId]
    );

    let token: string;
    if (tokenResult.rows.length === 0) {
      token = uuidv4();
      await query(
        'INSERT INTO dispatch_tokens (consumer_id, course_id, token) VALUES ($1, $2, $3)',
        [consumerId, courseId, token]
      );
    } else {
      token = tokenResult.rows[0].token;
    }

    const course = courseResult.rows[0];
    const launchUrl = `${config.baseUrl}/dispatch/launch/${token}`;

    res.json({
      courseId,
      courseTitle: course.title,
      dispatchToken: token,
      launchUrl,
      scormPackageInfo: {
        description: 'Download the dispatch package and upload it to your LMS',
        downloadUrl: `${config.baseUrl}/admin/dispatch/download/${courseId}?consumerId=${consumerId}`,
      },
    });
  } catch (error) {
    console.error('Dispatch package error:', error);
    res.status(500).json({ error: 'Failed to generate dispatch info' });
  }
});
