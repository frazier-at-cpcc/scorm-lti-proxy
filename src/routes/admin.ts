import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { config } from '../config.js';
import { query } from '../db/index.js';
import { extractScormPackage, parseManifest } from '../services/content-manager.js';
import { generateDispatchPackage } from '../services/dispatch-generator.js';
import { v4 as uuidv4 } from 'uuid';

export const adminRouter = Router();

// File upload configuration
const upload = multer({
  dest: path.join(process.cwd(), 'uploads'),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

// === Consumer Management ===

// List consumers
adminRouter.get('/consumers', async (_req: Request, res: Response) => {
  try {
    const result = await query<{
      id: string;
      name: string;
      lti_consumer_key: string;
      active: boolean;
      created_at: Date;
    }>(
      'SELECT id, name, lti_consumer_key, active, created_at FROM consumers ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('List consumers error:', error);
    res.status(500).json({ error: 'Failed to list consumers' });
  }
});

// Create consumer
adminRouter.post('/consumers', async (req: Request, res: Response) => {
  try {
    const { name, xapi_lrs_endpoint, xapi_lrs_key, xapi_lrs_secret } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const id = uuidv4();
    const consumerKey = `key_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
    const consumerSecret = uuidv4().replace(/-/g, '');

    await query(
      `INSERT INTO consumers (id, name, lti_consumer_key, lti_consumer_secret,
        xapi_lrs_endpoint, xapi_lrs_key, xapi_lrs_secret)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, name, consumerKey, consumerSecret, xapi_lrs_endpoint, xapi_lrs_key, xapi_lrs_secret]
    );

    res.status(201).json({
      id,
      name,
      lti_consumer_key: consumerKey,
      lti_consumer_secret: consumerSecret,
      lti_launch_url: `${config.baseUrl}/lti/launch`,
    });
  } catch (error) {
    console.error('Create consumer error:', error);
    res.status(500).json({ error: 'Failed to create consumer' });
  }
});

// Get consumer details (including secret for LTI setup)
adminRouter.get('/consumers/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await query<{
      id: string;
      name: string;
      lti_consumer_key: string;
      lti_consumer_secret: string;
      xapi_lrs_endpoint: string | null;
      active: boolean;
      created_at: Date;
    }>(
      `SELECT id, name, lti_consumer_key, lti_consumer_secret,
              xapi_lrs_endpoint, active, created_at
       FROM consumers WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Consumer not found' });
    }

    const consumer = result.rows[0];
    res.json({
      ...consumer,
      lti_launch_url: `${config.baseUrl}/lti/launch`,
    });
  } catch (error) {
    console.error('Get consumer error:', error);
    res.status(500).json({ error: 'Failed to get consumer' });
  }
});

// === Course Management ===

// List courses
adminRouter.get('/courses', async (_req: Request, res: Response) => {
  try {
    const result = await query<{
      id: string;
      title: string;
      scorm_version: string;
      active: boolean;
      created_at: Date;
    }>(
      'SELECT id, title, scorm_version, active, created_at FROM courses ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('List courses error:', error);
    res.status(500).json({ error: 'Failed to list courses' });
  }
});

// Upload SCORM package
adminRouter.post('/courses', upload.single('package'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { title } = req.body;
    const courseId = uuidv4();
    const contentPath = path.join(config.content.dir, courseId);

    // Extract SCORM package
    await extractScormPackage(req.file.path, contentPath);

    // Parse manifest
    const manifestPath = path.join(contentPath, 'imsmanifest.xml');
    const manifest = await parseManifest(manifestPath);

    // Create course record
    await query(
      `INSERT INTO courses (id, title, scorm_version, launch_path, manifest_data, content_path)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        courseId,
        title || manifest.title || 'Untitled Course',
        manifest.scormVersion,
        manifest.launchPath,
        JSON.stringify(manifest),
        contentPath,
      ]
    );

    // Clean up uploaded file
    await fs.unlink(req.file.path);

    res.status(201).json({
      id: courseId,
      title: title || manifest.title,
      scorm_version: manifest.scormVersion,
      launch_path: manifest.launchPath,
    });
  } catch (error) {
    console.error('Upload course error:', error);

    // Clean up on error
    if (req.file) {
      await fs.unlink(req.file.path).catch(() => {});
    }

    res.status(500).json({ error: 'Failed to upload course' });
  }
});

// Get course details
adminRouter.get('/courses/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await query<{
      id: string;
      title: string;
      description: string | null;
      scorm_version: string;
      launch_path: string;
      manifest_data: Record<string, unknown>;
      active: boolean;
      created_at: Date;
    }>(
      `SELECT id, title, description, scorm_version, launch_path,
              manifest_data, active, created_at
       FROM courses WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Course not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get course error:', error);
    res.status(500).json({ error: 'Failed to get course' });
  }
});

// Delete course
adminRouter.delete('/courses/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Get content path before deleting
    const courseResult = await query<{ content_path: string }>(
      'SELECT content_path FROM courses WHERE id = $1',
      [id]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({ error: 'Course not found' });
    }

    // Soft delete (set active = false)
    await query('UPDATE courses SET active = false WHERE id = $1', [id]);

    res.json({ success: true });
  } catch (error) {
    console.error('Delete course error:', error);
    res.status(500).json({ error: 'Failed to delete course' });
  }
});

// === Dispatch Package Generation ===

// Download dispatch package
adminRouter.get('/dispatch/download/:courseId', async (req: Request, res: Response) => {
  try {
    const { courseId } = req.params;
    const { consumerId } = req.query;

    if (!consumerId) {
      return res.status(400).json({ error: 'consumerId required' });
    }

    // Get course and consumer info
    const courseResult = await query<{ id: string; title: string }>(
      'SELECT id, title FROM courses WHERE id = $1 AND active = true',
      [courseId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({ error: 'Course not found' });
    }

    const consumerResult = await query<{ id: string }>(
      'SELECT id FROM consumers WHERE id = $1 AND active = true',
      [consumerId as string]
    );

    if (consumerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Consumer not found' });
    }

    // Get or create dispatch token
    let tokenResult = await query<{ token: string }>(
      'SELECT token FROM dispatch_tokens WHERE consumer_id = $1 AND course_id = $2 AND active = true',
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

    // Generate dispatch package
    const course = courseResult.rows[0];
    const launchUrl = `${config.baseUrl}/dispatch/launch/${token}`;
    const packageBuffer = await generateDispatchPackage(course.title, launchUrl);

    // Send as download
    const filename = `${course.title.replace(/[^a-z0-9]/gi, '_')}_dispatch.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(packageBuffer);
  } catch (error) {
    console.error('Download dispatch error:', error);
    res.status(500).json({ error: 'Failed to generate dispatch package' });
  }
});

// === Reporting ===

// Get launch statistics
adminRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    const stats = await query<{
      total_consumers: string;
      total_courses: string;
      total_launches: string;
      total_completions: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM consumers WHERE active = true) as total_consumers,
        (SELECT COUNT(*) FROM courses WHERE active = true) as total_courses,
        (SELECT COUNT(*) FROM launches) as total_launches,
        (SELECT COUNT(*) FROM attempts WHERE completion_status = 'completed') as total_completions
    `);

    res.json(stats.rows[0]);
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// Get recent launches
adminRouter.get('/launches', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;

    const result = await query<{
      id: string;
      user_id: string;
      course_title: string;
      consumer_name: string;
      created_at: Date;
      completion_status: string;
      score: number | null;
    }>(
      `SELECT l.id, l.user_id, c.title as course_title, con.name as consumer_name,
              l.created_at, a.completion_status, a.score
       FROM launches l
       JOIN courses c ON l.course_id = c.id
       LEFT JOIN consumers con ON l.consumer_id = con.id
       LEFT JOIN attempts a ON a.launch_id = l.id
       ORDER BY l.created_at DESC
       LIMIT $1`,
      [limit]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Launches error:', error);
    res.status(500).json({ error: 'Failed to get launches' });
  }
});
