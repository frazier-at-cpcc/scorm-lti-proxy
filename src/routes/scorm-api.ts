import { Router, Request, Response } from 'express';
import { query } from '../db/index.js';
import { sendGradeToLms } from '../services/lti-outcomes.js';
import { sendXapiStatement } from '../services/xapi-client.js';

export const scormApiRouter = Router();

interface CmiData {
  'cmi.core.lesson_status'?: string;
  'cmi.core.score.raw'?: string;
  'cmi.core.score.min'?: string;
  'cmi.core.score.max'?: string;
  'cmi.core.session_time'?: string;
  'cmi.core.total_time'?: string;
  'cmi.suspend_data'?: string;
  'cmi.core.lesson_location'?: string;
  [key: string]: string | undefined;
}

// Get attempt data (for resuming)
scormApiRouter.get('/attempt/:attemptId', async (req: Request, res: Response) => {
  try {
    const { attemptId } = req.params;

    const result = await query<{
      id: string;
      cmi_data: CmiData;
      completion_status: string;
      score: number | null;
    }>(
      'SELECT id, cmi_data, completion_status, score FROM attempts WHERE id = $1',
      [attemptId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Attempt not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get attempt error:', error);
    res.status(500).json({ error: 'Failed to get attempt data' });
  }
});

// Get course info
scormApiRouter.get('/course/:courseId', async (req: Request, res: Response) => {
  try {
    const { courseId } = req.params;

    const result = await query<{
      id: string;
      title: string;
      scorm_version: string;
      launch_path: string;
      content_path: string;
    }>(
      'SELECT id, title, scorm_version, launch_path, content_path FROM courses WHERE id = $1 AND active = true',
      [courseId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Course not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get course error:', error);
    res.status(500).json({ error: 'Failed to get course data' });
  }
});

// Save CMI data (LMSCommit)
scormApiRouter.post('/attempt/:attemptId/commit', async (req: Request, res: Response) => {
  try {
    const { attemptId } = req.params;
    const cmiData: CmiData = req.body;

    // Extract key values
    const lessonStatus = cmiData['cmi.core.lesson_status'];
    const scoreRaw = cmiData['cmi.core.score.raw'];
    const scoreMax = cmiData['cmi.core.score.max'] || '100';
    const totalTime = cmiData['cmi.core.total_time'];

    // Calculate normalized score (0-1 for LTI)
    let normalizedScore: number | null = null;
    if (scoreRaw !== undefined && scoreMax) {
      normalizedScore = parseFloat(scoreRaw) / parseFloat(scoreMax);
    }

    // Map SCORM status to our status
    let completionStatus = 'incomplete';
    let successStatus: string | null = null;

    if (lessonStatus) {
      if (['completed', 'passed'].includes(lessonStatus)) {
        completionStatus = 'completed';
      }
      if (lessonStatus === 'passed') {
        successStatus = 'passed';
      } else if (lessonStatus === 'failed') {
        successStatus = 'failed';
      }
    }

    // Update attempt
    await query(
      `UPDATE attempts SET
        cmi_data = $1,
        score = $2,
        completion_status = $3,
        success_status = $4,
        total_time = $5,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $6`,
      [
        JSON.stringify(cmiData),
        normalizedScore !== null ? normalizedScore * 100 : null,
        completionStatus,
        successStatus,
        totalTime,
        attemptId,
      ]
    );

    // Get launch info for grade passback
    const launchResult = await query<{
      consumer_id: string;
      lis_outcome_service_url: string | null;
      lis_result_sourcedid: string | null;
      user_id: string;
      course_id: string;
      launch_data: Record<string, unknown>;
    }>(
      `SELECT l.consumer_id, l.lis_outcome_service_url, l.lis_result_sourcedid,
              l.user_id, l.course_id, l.launch_data
       FROM launches l
       JOIN attempts a ON a.launch_id = l.id
       WHERE a.id = $1`,
      [attemptId]
    );

    if (launchResult.rows.length > 0) {
      const launch = launchResult.rows[0];

      // LTI grade passback (if available)
      if (
        launch.lis_outcome_service_url &&
        launch.lis_result_sourcedid &&
        normalizedScore !== null
      ) {
        try {
          await sendGradeToLms(
            launch.consumer_id,
            launch.lis_outcome_service_url,
            launch.lis_result_sourcedid,
            normalizedScore
          );
        } catch (gradeError) {
          console.error('Grade passback failed:', gradeError);
        }
      }

      // xAPI statement (for dispatch mode)
      const launchData = launch.launch_data as { type?: string };
      if (launchData?.type === 'dispatch') {
        try {
          await sendXapiStatement(
            launch.consumer_id,
            launch.user_id,
            launch.course_id,
            {
              verb: completionStatus === 'completed' ? 'completed' : 'progressed',
              score: normalizedScore,
              success: successStatus === 'passed',
            }
          );
        } catch (xapiError) {
          console.error('xAPI statement failed:', xapiError);
        }
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Commit error:', error);
    res.status(500).json({ error: 'Failed to save data' });
  }
});

// Finish attempt (LMSFinish)
scormApiRouter.post('/attempt/:attemptId/finish', async (req: Request, res: Response) => {
  try {
    const { attemptId } = req.params;

    await query(
      'UPDATE attempts SET finished_at = CURRENT_TIMESTAMP WHERE id = $1',
      [attemptId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Finish error:', error);
    res.status(500).json({ error: 'Failed to finish attempt' });
  }
});
