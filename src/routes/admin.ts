import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { config, updateRuntimeConfig } from '../config.js';
import { query } from '../db/index.js';
import { extractScormPackage, parseManifest } from '../services/content-manager.js';
import { generateDispatchPackage } from '../services/dispatch-generator.js';
import { generateIMSCC } from '../services/imscc-generator.js';
import { requireAuth, handleLogin, handleLogout, checkAuthStatus } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

export const adminRouter = Router();

// File upload configuration
const upload = multer({
  dest: path.join(process.cwd(), 'uploads'),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
});

// === Authentication Routes (public) ===

// Serve login page
adminRouter.get('/login', (_req: Request, res: Response) => {
  res.send(getLoginPage());
});

// Handle login
adminRouter.post('/login', handleLogin);

// Handle logout
adminRouter.post('/logout', handleLogout);
adminRouter.get('/logout', handleLogout);

// Check auth status (API)
adminRouter.get('/api/auth/status', checkAuthStatus);

// === Protected Routes (require auth) ===

// Serve admin dashboard
adminRouter.get('/', requireAuth, (_req: Request, res: Response) => {
  res.send(getDashboardPage());
});

// === API Endpoints (protected) ===

// Get dashboard stats
adminRouter.get('/api/stats', requireAuth, async (_req: Request, res: Response) => {
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

// === Consumer Management ===

// List consumers
adminRouter.get('/api/consumers', requireAuth, async (_req: Request, res: Response) => {
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
adminRouter.post('/api/consumers', requireAuth, async (req: Request, res: Response) => {
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

// Get consumer details
adminRouter.get('/api/consumers/:id', requireAuth, async (req: Request, res: Response) => {
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

// Delete consumer
adminRouter.delete('/api/consumers/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await query('UPDATE consumers SET active = false WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete consumer error:', error);
    res.status(500).json({ error: 'Failed to delete consumer' });
  }
});

// === Course Management ===

// List courses (only active/non-deleted courses)
adminRouter.get('/api/courses', requireAuth, async (_req: Request, res: Response) => {
  try {
    const result = await query<{
      id: string;
      title: string;
      scorm_version: string;
      active: boolean;
      created_at: Date;
    }>(
      'SELECT id, title, scorm_version, active, created_at FROM courses WHERE active = true ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('List courses error:', error);
    res.status(500).json({ error: 'Failed to list courses' });
  }
});

// Upload SCORM package
adminRouter.post('/api/courses', requireAuth, upload.single('package'), async (req: Request, res: Response) => {
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
adminRouter.get('/api/courses/:id', requireAuth, async (req: Request, res: Response) => {
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

// Delete course (full deletion - removes database records and content files)
adminRouter.delete('/api/courses/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const courseResult = await query<{ content_path: string }>(
      'SELECT content_path FROM courses WHERE id = $1',
      [id]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({ error: 'Course not found' });
    }

    const contentPath = courseResult.rows[0].content_path;

    // Delete related records first (respecting foreign key constraints)
    // Delete attempts (via launches)
    await query(
      `DELETE FROM attempts WHERE launch_id IN (SELECT id FROM launches WHERE course_id = $1)`,
      [id]
    );

    // Delete launches
    await query('DELETE FROM launches WHERE course_id = $1', [id]);

    // Delete dispatch tokens
    await query('DELETE FROM dispatch_tokens WHERE course_id = $1', [id]);

    // Remove from suites
    await query('DELETE FROM suite_courses WHERE course_id = $1', [id]);

    // Delete the course record
    await query('DELETE FROM courses WHERE id = $1', [id]);

    // Delete content directory from filesystem
    if (contentPath) {
      fs.rm(contentPath, { recursive: true, force: true }).catch(err => {
        console.error('Failed to remove content directory:', err);
      });
    }

    res.json({ success: true, message: 'Course and all related data deleted' });
  } catch (error) {
    console.error('Delete course error:', error);
    res.status(500).json({ error: 'Failed to delete course' });
  }
});

// Bulk upload SCORM packages
adminRouter.post('/api/courses/bulk', requireAuth, upload.array('packages', 50), async (req: Request, res: Response) => {
  const files = req.files as Express.Multer.File[];
  const results: { filename: string; success: boolean; id?: string; title?: string; error?: string }[] = [];

  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  for (const file of files) {
    try {
      const courseId = uuidv4();
      const contentPath = path.join(config.content.dir, courseId);

      // Extract SCORM package
      await extractScormPackage(file.path, contentPath);

      // Parse manifest
      const manifestPath = path.join(contentPath, 'imsmanifest.xml');
      const manifest = await parseManifest(manifestPath);

      // Create course record
      await query(
        `INSERT INTO courses (id, title, scorm_version, launch_path, manifest_data, content_path)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          courseId,
          manifest.title || file.originalname.replace(/\.zip$/i, ''),
          manifest.scormVersion,
          manifest.launchPath,
          JSON.stringify(manifest),
          contentPath,
        ]
      );

      // Clean up uploaded file
      await fs.unlink(file.path);

      results.push({
        filename: file.originalname,
        success: true,
        id: courseId,
        title: manifest.title,
      });
    } catch (error) {
      console.error(`Bulk upload error for ${file.originalname}:`, error);

      // Clean up on error
      await fs.unlink(file.path).catch(() => {});

      results.push({
        filename: file.originalname,
        success: false,
        error: error instanceof Error ? error.message : 'Upload failed',
      });
    }
  }

  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;

  res.json({
    message: `Uploaded ${successCount} of ${files.length} packages`,
    successCount,
    failCount,
    results,
  });
});

// Replace SCORM package for existing course
adminRouter.put('/api/courses/:id/replace', requireAuth, upload.single('package'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Get existing course
    const courseResult = await query<{ id: string; content_path: string; title: string }>(
      'SELECT id, content_path, title FROM courses WHERE id = $1',
      [id]
    );

    if (courseResult.rows.length === 0) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(404).json({ error: 'Course not found' });
    }

    const existingCourse = courseResult.rows[0];
    const oldContentPath = existingCourse.content_path;

    // Create new content path with timestamp to avoid conflicts
    const newContentPath = path.join(config.content.dir, `${id}_${Date.now()}`);

    // Extract new SCORM package
    await extractScormPackage(req.file.path, newContentPath);

    // Parse manifest
    const manifestPath = path.join(newContentPath, 'imsmanifest.xml');
    const manifest = await parseManifest(manifestPath);

    // Update course record
    await query(
      `UPDATE courses SET
         scorm_version = $1,
         launch_path = $2,
         manifest_data = $3,
         content_path = $4,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [
        manifest.scormVersion,
        manifest.launchPath,
        JSON.stringify(manifest),
        newContentPath,
        id,
      ]
    );

    // Clean up uploaded file
    await fs.unlink(req.file.path);

    // Remove old content directory (async, don't wait)
    fs.rm(oldContentPath, { recursive: true, force: true }).catch(err => {
      console.error('Failed to remove old content:', err);
    });

    res.json({
      success: true,
      id,
      title: existingCourse.title,
      scorm_version: manifest.scormVersion,
      launch_path: manifest.launchPath,
    });
  } catch (error) {
    console.error('Replace course error:', error);

    // Clean up on error
    if (req.file) {
      await fs.unlink(req.file.path).catch(() => {});
    }

    res.status(500).json({ error: 'Failed to replace course package' });
  }
});

// === Dispatch Package Generation ===

adminRouter.get('/api/dispatch/download/:courseId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { courseId } = req.params;
    const { consumerId } = req.query;

    if (!consumerId) {
      return res.status(400).json({ error: 'consumerId required' });
    }

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

    const filename = `${course.title.replace(/[^a-z0-9]/gi, '_')}_dispatch.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(packageBuffer);
  } catch (error) {
    console.error('Download dispatch error:', error);
    res.status(500).json({ error: 'Failed to generate dispatch package' });
  }
});

// === Launch History ===

adminRouter.get('/api/launches', requireAuth, async (req: Request, res: Response) => {
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

// === Suite Management ===

// List suites
adminRouter.get('/api/suites', requireAuth, async (_req: Request, res: Response) => {
  try {
    const result = await query<{
      id: string;
      title: string;
      description: string | null;
      active: boolean;
      created_at: Date;
      course_count: string;
    }>(
      `SELECT s.id, s.title, s.description, s.active, s.created_at,
              COUNT(sc.course_id) as course_count
       FROM suites s
       LEFT JOIN suite_courses sc ON s.id = sc.suite_id
       WHERE s.active = true
       GROUP BY s.id
       ORDER BY s.created_at DESC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('List suites error:', error);
    res.status(500).json({ error: 'Failed to list suites' });
  }
});

// Create suite
adminRouter.post('/api/suites', requireAuth, async (req: Request, res: Response) => {
  try {
    const { title, description } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }

    const id = uuidv4();
    await query(
      'INSERT INTO suites (id, title, description) VALUES ($1, $2, $3)',
      [id, title, description || null]
    );

    res.status(201).json({ id, title, description });
  } catch (error) {
    console.error('Create suite error:', error);
    res.status(500).json({ error: 'Failed to create suite' });
  }
});

// Get suite details with courses
adminRouter.get('/api/suites/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const suiteResult = await query<{
      id: string;
      title: string;
      description: string | null;
      active: boolean;
      created_at: Date;
    }>(
      'SELECT id, title, description, active, created_at FROM suites WHERE id = $1',
      [id]
    );

    if (suiteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Suite not found' });
    }

    const coursesResult = await query<{
      id: string;
      title: string;
      scorm_version: string;
      sort_order: number;
    }>(
      `SELECT c.id, c.title, c.scorm_version, sc.sort_order
       FROM courses c
       JOIN suite_courses sc ON c.id = sc.course_id
       WHERE sc.suite_id = $1 AND c.active = true
       ORDER BY sc.sort_order`,
      [id]
    );

    res.json({
      ...suiteResult.rows[0],
      courses: coursesResult.rows,
    });
  } catch (error) {
    console.error('Get suite error:', error);
    res.status(500).json({ error: 'Failed to get suite' });
  }
});

// Update suite
adminRouter.put('/api/suites/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { title, description } = req.body;

    await query(
      'UPDATE suites SET title = COALESCE($1, title), description = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [title, description, id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Update suite error:', error);
    res.status(500).json({ error: 'Failed to update suite' });
  }
});

// Delete suite
adminRouter.delete('/api/suites/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await query('UPDATE suites SET active = false WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete suite error:', error);
    res.status(500).json({ error: 'Failed to delete suite' });
  }
});

// Add course to suite
adminRouter.post('/api/suites/:id/courses', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { courseId } = req.body;

    if (!courseId) {
      return res.status(400).json({ error: 'courseId is required' });
    }

    // Get next sort order
    const orderResult = await query<{ max_order: number | null }>(
      'SELECT MAX(sort_order) as max_order FROM suite_courses WHERE suite_id = $1',
      [id]
    );
    const nextOrder = (orderResult.rows[0]?.max_order || 0) + 1;

    await query(
      'INSERT INTO suite_courses (suite_id, course_id, sort_order) VALUES ($1, $2, $3) ON CONFLICT (suite_id, course_id) DO NOTHING',
      [id, courseId, nextOrder]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Add course to suite error:', error);
    res.status(500).json({ error: 'Failed to add course to suite' });
  }
});

// Remove course from suite
adminRouter.delete('/api/suites/:id/courses/:courseId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id, courseId } = req.params;
    await query('DELETE FROM suite_courses WHERE suite_id = $1 AND course_id = $2', [id, courseId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Remove course from suite error:', error);
    res.status(500).json({ error: 'Failed to remove course from suite' });
  }
});

// Reorder courses in suite
adminRouter.put('/api/suites/:id/reorder', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { courseIds } = req.body;

    if (!Array.isArray(courseIds)) {
      return res.status(400).json({ error: 'courseIds must be an array' });
    }

    // Update sort order for each course
    for (let i = 0; i < courseIds.length; i++) {
      await query(
        'UPDATE suite_courses SET sort_order = $1 WHERE suite_id = $2 AND course_id = $3',
        [i, id, courseIds[i]]
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Reorder courses error:', error);
    res.status(500).json({ error: 'Failed to reorder courses' });
  }
});

// Download IMSCC for suite
adminRouter.get('/api/suites/:id/imscc', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { consumerId } = req.query;

    if (!consumerId) {
      return res.status(400).json({ error: 'consumerId required' });
    }

    // Get suite
    const suiteResult = await query<{
      id: string;
      title: string;
      description: string | null;
    }>(
      'SELECT id, title, description FROM suites WHERE id = $1 AND active = true',
      [id]
    );

    if (suiteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Suite not found' });
    }

    // Get consumer credentials
    const consumerResult = await query<{
      lti_consumer_key: string;
      lti_consumer_secret: string;
    }>(
      'SELECT lti_consumer_key, lti_consumer_secret FROM consumers WHERE id = $1 AND active = true',
      [consumerId as string]
    );

    if (consumerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Consumer not found' });
    }

    // Get courses in suite
    const coursesResult = await query<{
      id: string;
      title: string;
      description: string | null;
      sort_order: number;
    }>(
      `SELECT c.id, c.title, c.description, sc.sort_order
       FROM courses c
       JOIN suite_courses sc ON c.id = sc.course_id
       WHERE sc.suite_id = $1 AND c.active = true
       ORDER BY sc.sort_order`,
      [id]
    );

    if (coursesResult.rows.length === 0) {
      return res.status(400).json({ error: 'Suite has no courses' });
    }

    const suite = suiteResult.rows[0];
    const consumer = consumerResult.rows[0];
    const courses = coursesResult.rows.map(c => ({
      id: c.id,
      title: c.title,
      description: c.description || undefined,
      sortOrder: c.sort_order,
    }));

    // Generate IMSCC
    const imsccBuffer = generateIMSCC(
      { id: suite.id, title: suite.title, description: suite.description || undefined },
      courses,
      consumer
    );

    const filename = `${suite.title.replace(/[^a-z0-9]/gi, '_')}.imscc`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(imsccBuffer);
  } catch (error) {
    console.error('Download IMSCC error:', error);
    res.status(500).json({ error: 'Failed to generate IMSCC' });
  }
});

// === Settings ===

// Get settings
adminRouter.get('/api/settings', requireAuth, async (_req: Request, res: Response) => {
  try {
    const result = await query<{ key: string; value: string }>(
      'SELECT key, value FROM settings'
    );

    const settings: Record<string, string> = {};
    result.rows.forEach(row => {
      settings[row.key] = row.value;
    });

    // Include current baseUrl (from config or DB)
    if (!settings.base_url) {
      settings.base_url = config.baseUrl;
    }

    res.json(settings);
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// Update settings
adminRouter.put('/api/settings', requireAuth, async (req: Request, res: Response) => {
  try {
    const { base_url } = req.body;

    if (base_url) {
      // Validate URL format
      try {
        new URL(base_url);
      } catch {
        return res.status(400).json({ error: 'Invalid URL format' });
      }

      // Save to database
      await query(
        `INSERT INTO settings (key, value, updated_at)
         VALUES ('base_url', $1, CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
        [base_url]
      );

      // Update runtime config
      updateRuntimeConfig({ baseUrl: base_url });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// === Legacy routes (for backwards compatibility) ===
// These redirect to the new /api/ prefixed routes

adminRouter.get('/consumers', requireAuth, (_req, res) => res.redirect('/admin/api/consumers'));
adminRouter.get('/courses', requireAuth, (_req, res) => res.redirect('/admin/api/courses'));
adminRouter.get('/stats', requireAuth, (_req, res) => res.redirect('/admin/api/stats'));
adminRouter.get('/launches', requireAuth, (_req, res) => res.redirect('/admin/api/launches'));

// === HTML Templates ===

function getLoginPage(): string {
  const error = '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login - SCORM-LTI Admin</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-container {
      background: white;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      width: 100%;
      max-width: 400px;
    }
    h1 {
      text-align: center;
      color: #333;
      margin-bottom: 8px;
      font-size: 24px;
    }
    .subtitle {
      text-align: center;
      color: #666;
      margin-bottom: 32px;
      font-size: 14px;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      margin-bottom: 8px;
      color: #333;
      font-weight: 500;
    }
    input {
      width: 100%;
      padding: 12px 16px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 16px;
      transition: border-color 0.2s;
    }
    input:focus {
      outline: none;
      border-color: #667eea;
    }
    button {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    }
    .error {
      background: #fee;
      color: #c00;
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 20px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <h1>SCORM-LTI Proxy</h1>
    <p class="subtitle">Admin Dashboard</p>
    <div id="error" class="error" style="display: none;"></div>
    <form method="POST" action="/admin/login">
      <div class="form-group">
        <label for="username">Username</label>
        <input type="text" id="username" name="username" required autofocus>
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required>
      </div>
      <button type="submit">Sign In</button>
    </form>
  </div>
  <script>
    const params = new URLSearchParams(window.location.search);
    if (params.get('error') === 'invalid') {
      document.getElementById('error').textContent = 'Invalid username or password';
      document.getElementById('error').style.display = 'block';
    }
  </script>
</body>
</html>`;
}

function getDashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Dashboard - SCORM-LTI Proxy</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f7fa;
      color: #333;
    }
    .navbar {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 16px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    .navbar h1 { font-size: 20px; font-weight: 600; }
    .navbar a { color: white; text-decoration: none; opacity: 0.9; }
    .navbar a:hover { opacity: 1; }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 24px;
      border-bottom: 2px solid #e0e0e0;
      padding-bottom: 0;
    }
    .tab {
      padding: 12px 24px;
      cursor: pointer;
      border: none;
      background: none;
      font-size: 14px;
      font-weight: 500;
      color: #666;
      border-bottom: 2px solid transparent;
      margin-bottom: -2px;
      transition: all 0.2s;
    }
    .tab:hover { color: #667eea; }
    .tab.active { color: #667eea; border-bottom-color: #667eea; }
    .panel { display: none; }
    .panel.active { display: block; }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 32px;
    }
    .stat-card {
      background: white;
      padding: 24px;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    }
    .stat-card h3 { color: #666; font-size: 14px; font-weight: 500; margin-bottom: 8px; }
    .stat-card .value { font-size: 32px; font-weight: 700; color: #333; }
    .card {
      background: white;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      margin-bottom: 24px;
    }
    .card-header {
      padding: 20px 24px;
      border-bottom: 1px solid #eee;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .card-header h2 { font-size: 18px; font-weight: 600; }
    .card-body { padding: 24px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #eee; }
    th { font-weight: 600; color: #666; font-size: 13px; text-transform: uppercase; }
    tr:hover { background: #f9f9f9; }
    .btn {
      padding: 10px 20px;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-primary {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(102,126,234,0.4); }
    .btn-secondary { background: #e0e0e0; color: #333; }
    .btn-secondary:hover { background: #d0d0d0; }
    .btn-danger { background: #dc3545; color: white; }
    .btn-danger:hover { background: #c82333; }
    .btn-sm { padding: 6px 12px; font-size: 12px; }
    .badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
    }
    .badge-success { background: #d4edda; color: #155724; }
    .badge-warning { background: #fff3cd; color: #856404; }
    .badge-info { background: #cce5ff; color: #004085; }
    .modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.5);
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .modal.active { display: flex; }
    .modal-content {
      background: white;
      padding: 32px;
      border-radius: 12px;
      width: 100%;
      max-width: 500px;
      max-height: 90vh;
      overflow-y: auto;
    }
    .modal-content h2 { margin-bottom: 24px; }
    .form-group { margin-bottom: 20px; }
    .form-group label { display: block; margin-bottom: 8px; font-weight: 500; }
    .form-group input, .form-group select {
      width: 100%;
      padding: 10px 14px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 14px;
    }
    .form-group input:focus, .form-group select:focus {
      outline: none;
      border-color: #667eea;
    }
    .form-actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 24px; }
    .credentials-box {
      background: #f8f9fa;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      padding: 16px;
      margin-top: 16px;
    }
    .credentials-box h4 { margin-bottom: 12px; color: #333; }
    .credential-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid #eee;
    }
    .credential-row:last-child { border-bottom: none; }
    .credential-row label { font-weight: 500; color: #666; }
    .credential-row code {
      background: #e9ecef;
      padding: 4px 8px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 13px;
    }
    .empty-state {
      text-align: center;
      padding: 48px;
      color: #666;
    }
    .empty-state h3 { margin-bottom: 8px; color: #333; }
    .copy-btn {
      background: none;
      border: 1px solid #ddd;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    .copy-btn:hover { background: #f0f0f0; }
  </style>
</head>
<body>
  <nav class="navbar">
    <h1>SCORM-LTI Proxy</h1>
    <a href="/admin/logout">Logout</a>
  </nav>

  <div class="container">
    <div class="tabs">
      <button class="tab active" data-panel="dashboard">Dashboard</button>
      <button class="tab" data-panel="consumers">Consumers</button>
      <button class="tab" data-panel="courses">Courses</button>
      <button class="tab" data-panel="suites">Suites</button>
      <button class="tab" data-panel="launches">Launch History</button>
      <button class="tab" data-panel="settings">Settings</button>
    </div>

    <!-- Dashboard Panel -->
    <div id="dashboard" class="panel active">
      <div class="stats-grid">
        <div class="stat-card">
          <h3>Total Consumers</h3>
          <div class="value" id="stat-consumers">-</div>
        </div>
        <div class="stat-card">
          <h3>Total Courses</h3>
          <div class="value" id="stat-courses">-</div>
        </div>
        <div class="stat-card">
          <h3>Total Launches</h3>
          <div class="value" id="stat-launches">-</div>
        </div>
        <div class="stat-card">
          <h3>Completions</h3>
          <div class="value" id="stat-completions">-</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h2>Quick Start Guide</h2>
        </div>
        <div class="card-body">
          <ol style="line-height: 2; padding-left: 20px;">
            <li><strong>Create a Consumer</strong> - Add an LMS or customer that will use your content</li>
            <li><strong>Upload Courses</strong> - Upload SCORM 1.2 or 2004 packages</li>
            <li><strong>Configure LTI</strong> - Use the provided key/secret in the customer's LMS</li>
            <li><strong>Or use Dispatch</strong> - Download thin packages for non-LTI systems</li>
          </ol>
        </div>
      </div>
    </div>

    <!-- Consumers Panel -->
    <div id="consumers" class="panel">
      <div class="card">
        <div class="card-header">
          <h2>Consumers</h2>
          <button class="btn btn-primary" onclick="showCreateConsumerModal()">Add Consumer</button>
        </div>
        <div class="card-body">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Consumer Key</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="consumers-table">
              <tr><td colspan="5" class="empty-state">Loading...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Courses Panel -->
    <div id="courses" class="panel">
      <div class="card">
        <div class="card-header">
          <h2>Courses</h2>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-primary" onclick="showUploadCourseModal()">Upload Course</button>
            <button class="btn btn-secondary" onclick="showBulkUploadModal()">Bulk Upload</button>
          </div>
        </div>
        <div class="card-body">
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>SCORM Version</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="courses-table">
              <tr><td colspan="5" class="empty-state">Loading...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Launches Panel -->
    <div id="launches" class="panel">
      <div class="card">
        <div class="card-header">
          <h2>Recent Launches</h2>
          <button class="btn btn-secondary" onclick="loadLaunches()">Refresh</button>
        </div>
        <div class="card-body">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Course</th>
                <th>Consumer</th>
                <th>Status</th>
                <th>Score</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody id="launches-table">
              <tr><td colspan="6" class="empty-state">Loading...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Suites Panel -->
    <div id="suites" class="panel">
      <div class="card">
        <div class="card-header">
          <h2>Course Suites</h2>
          <button class="btn btn-primary" onclick="showCreateSuiteModal()">Create Suite</button>
        </div>
        <div class="card-body">
          <p style="color: #666; margin-bottom: 16px;">Suites group multiple SCORM courses together for export as IMS Common Cartridge (IMSCC) files that can be imported into Canvas, Moodle, or Brightspace.</p>
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Courses</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="suites-table">
              <tr><td colspan="4" class="empty-state">Loading...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Settings Panel -->
    <div id="settings" class="panel">
      <div class="card">
        <div class="card-header">
          <h2>Server Settings</h2>
        </div>
        <div class="card-body">
          <form id="settingsForm">
            <div class="form-group">
              <label>Base URL</label>
              <input type="url" name="base_url" id="settings-base-url" placeholder="https://your-server.com" required>
              <p style="color: #666; font-size: 13px; margin-top: 8px;">The public URL of this server. Used in LTI launch URLs and IMSCC exports.</p>
            </div>
            <div class="form-actions" style="justify-content: flex-start;">
              <button type="submit" class="btn btn-primary">Save Settings</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  </div>

  <!-- Create Consumer Modal -->
  <div id="createConsumerModal" class="modal">
    <div class="modal-content">
      <h2>Add New Consumer</h2>
      <form id="createConsumerForm">
        <div class="form-group">
          <label>Name *</label>
          <input type="text" name="name" required placeholder="e.g., Acme University">
        </div>
        <div class="form-group">
          <label>xAPI LRS Endpoint (optional)</label>
          <input type="url" name="xapi_lrs_endpoint" placeholder="https://lrs.example.com/xapi">
        </div>
        <div class="form-group">
          <label>xAPI LRS Key (optional)</label>
          <input type="text" name="xapi_lrs_key">
        </div>
        <div class="form-group">
          <label>xAPI LRS Secret (optional)</label>
          <input type="password" name="xapi_lrs_secret">
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" onclick="closeModal('createConsumerModal')">Cancel</button>
          <button type="submit" class="btn btn-primary">Create Consumer</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Consumer Credentials Modal -->
  <div id="consumerCredentialsModal" class="modal">
    <div class="modal-content">
      <h2>LTI Credentials</h2>
      <p style="margin-bottom: 16px; color: #666;">Use these credentials to configure LTI in your LMS:</p>
      <div class="credentials-box">
        <div class="credential-row">
          <label>Launch URL</label>
          <div><code id="cred-launch-url"></code> <button class="copy-btn" onclick="copyToClipboard('cred-launch-url')">Copy</button></div>
        </div>
        <div class="credential-row">
          <label>Consumer Key</label>
          <div><code id="cred-key"></code> <button class="copy-btn" onclick="copyToClipboard('cred-key')">Copy</button></div>
        </div>
        <div class="credential-row">
          <label>Consumer Secret</label>
          <div><code id="cred-secret"></code> <button class="copy-btn" onclick="copyToClipboard('cred-secret')">Copy</button></div>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-primary" onclick="closeModal('consumerCredentialsModal')">Done</button>
      </div>
    </div>
  </div>

  <!-- Upload Course Modal -->
  <div id="uploadCourseModal" class="modal">
    <div class="modal-content">
      <h2>Upload SCORM Course</h2>
      <form id="uploadCourseForm" enctype="multipart/form-data">
        <div class="form-group">
          <label>Course Title (optional)</label>
          <input type="text" name="title" placeholder="Leave blank to use title from manifest">
        </div>
        <div class="form-group">
          <label>SCORM Package *</label>
          <input type="file" name="package" accept=".zip" required>
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" onclick="closeModal('uploadCourseModal')">Cancel</button>
          <button type="submit" class="btn btn-primary">Upload</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Bulk Upload Modal -->
  <div id="bulkUploadModal" class="modal">
    <div class="modal-content">
      <h2>Bulk Upload SCORM Courses</h2>
      <p style="color: #666; margin-bottom: 16px;">Select multiple SCORM packages (.zip files) to upload at once. Course titles will be extracted from the manifest.</p>
      <form id="bulkUploadForm" enctype="multipart/form-data">
        <div class="form-group">
          <label>SCORM Packages *</label>
          <input type="file" name="packages" accept=".zip" multiple required style="padding: 20px; border: 2px dashed #e0e0e0; border-radius: 8px; width: 100%; cursor: pointer;">
        </div>
        <div id="bulk-upload-status" style="display: none; margin-bottom: 16px;">
          <div style="background: #f8f9fa; border-radius: 8px; padding: 16px;">
            <div id="bulk-upload-progress" style="margin-bottom: 8px;">Uploading...</div>
            <div id="bulk-upload-results"></div>
          </div>
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" onclick="closeModal('bulkUploadModal')">Cancel</button>
          <button type="submit" class="btn btn-primary" id="bulk-upload-btn">Upload All</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Replace Course Modal -->
  <div id="replaceCourseModal" class="modal">
    <div class="modal-content">
      <h2>Replace SCORM Package</h2>
      <p style="color: #666; margin-bottom: 16px;">Upload a new SCORM package to replace the existing content for: <strong id="replace-course-title"></strong></p>
      <form id="replaceCourseForm" enctype="multipart/form-data">
        <input type="hidden" id="replace-course-id">
        <div class="form-group">
          <label>New SCORM Package *</label>
          <input type="file" name="package" accept=".zip" required>
        </div>
        <p style="color: #856404; background: #fff3cd; padding: 12px; border-radius: 8px; font-size: 13px; margin-bottom: 16px;">
          Warning: This will replace the course content. Existing learner progress will be preserved, but may not be compatible with the new content.
        </p>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" onclick="closeModal('replaceCourseModal')">Cancel</button>
          <button type="submit" class="btn btn-primary">Replace Package</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Dispatch Modal -->
  <div id="dispatchModal" class="modal">
    <div class="modal-content">
      <h2>Download Dispatch Package</h2>
      <p style="margin-bottom: 16px; color: #666;">Select a consumer to generate a dispatch package for:</p>
      <form id="dispatchForm">
        <input type="hidden" name="courseId" id="dispatch-course-id">
        <div class="form-group">
          <label>Consumer *</label>
          <select name="consumerId" id="dispatch-consumer-select" required>
            <option value="">Select a consumer...</option>
          </select>
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" onclick="closeModal('dispatchModal')">Cancel</button>
          <button type="submit" class="btn btn-primary">Download Package</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Create Suite Modal -->
  <div id="createSuiteModal" class="modal">
    <div class="modal-content">
      <h2>Create New Suite</h2>
      <form id="createSuiteForm">
        <div class="form-group">
          <label>Suite Title *</label>
          <input type="text" name="title" required placeholder="e.g., Safety Training 2024">
        </div>
        <div class="form-group">
          <label>Description (optional)</label>
          <input type="text" name="description" placeholder="Brief description of this course suite">
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" onclick="closeModal('createSuiteModal')">Cancel</button>
          <button type="submit" class="btn btn-primary">Create Suite</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Manage Suite Modal -->
  <div id="manageSuiteModal" class="modal">
    <div class="modal-content" style="max-width: 700px;">
      <h2 id="manage-suite-title">Manage Suite</h2>
      <input type="hidden" id="manage-suite-id">

      <div style="margin-bottom: 24px;">
        <h3 style="font-size: 14px; color: #666; margin-bottom: 12px;">Courses in this Suite</h3>
        <div id="suite-courses-list" style="border: 1px solid #e0e0e0; border-radius: 8px; min-height: 100px;">
          <div class="empty-state" style="padding: 24px;">No courses yet</div>
        </div>
      </div>

      <div style="margin-bottom: 24px;">
        <h3 style="font-size: 14px; color: #666; margin-bottom: 12px;">Add Course</h3>
        <div style="display: flex; gap: 12px;">
          <select id="add-course-select" style="flex: 1; padding: 10px 14px; border: 2px solid #e0e0e0; border-radius: 8px;">
            <option value="">Select a course to add...</option>
          </select>
          <button type="button" class="btn btn-primary" onclick="addCourseToSuite()">Add</button>
        </div>
      </div>

      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal('manageSuiteModal')">Close</button>
      </div>
    </div>
  </div>

  <!-- Download IMSCC Modal -->
  <div id="imsccModal" class="modal">
    <div class="modal-content">
      <h2>Download IMSCC</h2>
      <p style="margin-bottom: 16px; color: #666;">Select a consumer to generate an IMS Common Cartridge for import into Canvas, Moodle, or Brightspace:</p>
      <form id="imsccForm">
        <input type="hidden" id="imscc-suite-id">
        <div class="form-group">
          <label>Consumer *</label>
          <select name="consumerId" id="imscc-consumer-select" required>
            <option value="">Select a consumer...</option>
          </select>
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" onclick="closeModal('imsccModal')">Cancel</button>
          <button type="submit" class="btn btn-primary">Download IMSCC</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(tab.dataset.panel).classList.add('active');
      });
    });

    // Load data on page load
    loadStats();
    loadConsumers();
    loadCourses();
    loadLaunches();
    loadSuites();
    loadSettings();

    async function loadStats() {
      try {
        const res = await fetch('/admin/api/stats');
        const data = await res.json();
        document.getElementById('stat-consumers').textContent = data.total_consumers;
        document.getElementById('stat-courses').textContent = data.total_courses;
        document.getElementById('stat-launches').textContent = data.total_launches;
        document.getElementById('stat-completions').textContent = data.total_completions;
      } catch (e) {
        console.error('Failed to load stats:', e);
      }
    }

    async function loadConsumers() {
      try {
        const res = await fetch('/admin/api/consumers');
        const consumers = await res.json();
        const tbody = document.getElementById('consumers-table');

        if (consumers.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" class="empty-state"><h3>No consumers yet</h3><p>Add your first consumer to get started</p></td></tr>';
          return;
        }

        tbody.innerHTML = consumers.map(c => \`
          <tr>
            <td><strong>\${escapeHtml(c.name)}</strong></td>
            <td><code>\${c.lti_consumer_key}</code></td>
            <td><span class="badge \${c.active ? 'badge-success' : 'badge-warning'}">\${c.active ? 'Active' : 'Inactive'}</span></td>
            <td>\${new Date(c.created_at).toLocaleDateString()}</td>
            <td>
              <button class="btn btn-sm btn-secondary" onclick="showCredentials('\${c.id}')">Credentials</button>
              <button class="btn btn-sm btn-danger" onclick="deleteConsumer('\${c.id}')">Delete</button>
            </td>
          </tr>
        \`).join('');
      } catch (e) {
        console.error('Failed to load consumers:', e);
      }
    }

    async function loadCourses() {
      try {
        const res = await fetch('/admin/api/courses');
        const courses = await res.json();
        const tbody = document.getElementById('courses-table');

        if (courses.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" class="empty-state"><h3>No courses yet</h3><p>Upload your first SCORM package</p></td></tr>';
          return;
        }

        tbody.innerHTML = courses.map(c => \`
          <tr>
            <td><strong>\${escapeHtml(c.title)}</strong></td>
            <td><span class="badge badge-info">SCORM \${c.scorm_version}</span></td>
            <td><span class="badge \${c.active ? 'badge-success' : 'badge-warning'}">\${c.active ? 'Active' : 'Inactive'}</span></td>
            <td>\${new Date(c.created_at).toLocaleDateString()}</td>
            <td>
              <button class="btn btn-sm btn-secondary" onclick="showReplaceModal('\${c.id}', '\${escapeHtml(c.title).replace(/'/g, "\\\\'")}')">Replace</button>
              <button class="btn btn-sm btn-secondary" onclick="showDispatchModal('\${c.id}')">Dispatch</button>
              <button class="btn btn-sm btn-danger" onclick="deleteCourse('\${c.id}')">Delete</button>
            </td>
          </tr>
        \`).join('');
      } catch (e) {
        console.error('Failed to load courses:', e);
      }
    }

    async function loadLaunches() {
      try {
        const res = await fetch('/admin/api/launches?limit=50');
        const launches = await res.json();
        const tbody = document.getElementById('launches-table');

        if (launches.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><h3>No launches yet</h3><p>Launches will appear here when users access content</p></td></tr>';
          return;
        }

        tbody.innerHTML = launches.map(l => \`
          <tr>
            <td>\${escapeHtml(l.user_id)}</td>
            <td>\${escapeHtml(l.course_title)}</td>
            <td>\${escapeHtml(l.consumer_name || 'N/A')}</td>
            <td><span class="badge \${l.completion_status === 'completed' ? 'badge-success' : 'badge-warning'}">\${l.completion_status || 'In Progress'}</span></td>
            <td>\${l.score !== null ? l.score + '%' : '-'}</td>
            <td>\${new Date(l.created_at).toLocaleString()}</td>
          </tr>
        \`).join('');
      } catch (e) {
        console.error('Failed to load launches:', e);
      }
    }

    // Modal functions
    function showCreateConsumerModal() {
      document.getElementById('createConsumerForm').reset();
      document.getElementById('createConsumerModal').classList.add('active');
    }

    function showUploadCourseModal() {
      document.getElementById('uploadCourseForm').reset();
      document.getElementById('uploadCourseModal').classList.add('active');
    }

    async function showCredentials(consumerId) {
      try {
        const res = await fetch('/admin/api/consumers/' + consumerId);
        const consumer = await res.json();
        document.getElementById('cred-launch-url').textContent = consumer.lti_launch_url;
        document.getElementById('cred-key').textContent = consumer.lti_consumer_key;
        document.getElementById('cred-secret').textContent = consumer.lti_consumer_secret;
        document.getElementById('consumerCredentialsModal').classList.add('active');
      } catch (e) {
        alert('Failed to load credentials');
      }
    }

    async function showDispatchModal(courseId) {
      document.getElementById('dispatch-course-id').value = courseId;

      // Load consumers for select
      const res = await fetch('/admin/api/consumers');
      const consumers = await res.json();
      const select = document.getElementById('dispatch-consumer-select');
      select.innerHTML = '<option value="">Select a consumer...</option>' +
        consumers.filter(c => c.active).map(c => \`<option value="\${c.id}">\${escapeHtml(c.name)}</option>\`).join('');

      document.getElementById('dispatchModal').classList.add('active');
    }

    function closeModal(modalId) {
      document.getElementById(modalId).classList.remove('active');
    }

    // Close modals when clicking outside
    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal(modal.id);
      });
    });

    // Form submissions
    document.getElementById('createConsumerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const data = Object.fromEntries(formData.entries());

      try {
        const res = await fetch('/admin/api/consumers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });

        if (!res.ok) throw new Error('Failed to create consumer');

        const consumer = await res.json();
        closeModal('createConsumerModal');
        loadConsumers();
        loadStats();

        // Show credentials
        document.getElementById('cred-launch-url').textContent = consumer.lti_launch_url;
        document.getElementById('cred-key').textContent = consumer.lti_consumer_key;
        document.getElementById('cred-secret').textContent = consumer.lti_consumer_secret;
        document.getElementById('consumerCredentialsModal').classList.add('active');
      } catch (e) {
        alert('Failed to create consumer: ' + e.message);
      }
    });

    document.getElementById('uploadCourseForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);

      try {
        const res = await fetch('/admin/api/courses', {
          method: 'POST',
          body: formData
        });

        if (!res.ok) throw new Error('Failed to upload course');

        closeModal('uploadCourseModal');
        loadCourses();
        loadStats();
        alert('Course uploaded successfully!');
      } catch (e) {
        alert('Failed to upload course: ' + e.message);
      }
    });

    document.getElementById('dispatchForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const courseId = document.getElementById('dispatch-course-id').value;
      const consumerId = document.getElementById('dispatch-consumer-select').value;

      if (!consumerId) {
        alert('Please select a consumer');
        return;
      }

      window.location.href = '/admin/api/dispatch/download/' + courseId + '?consumerId=' + consumerId;
      closeModal('dispatchModal');
    });

    async function deleteConsumer(id) {
      if (!confirm('Are you sure you want to delete this consumer?')) return;

      try {
        await fetch('/admin/api/consumers/' + id, { method: 'DELETE' });
        loadConsumers();
        loadStats();
      } catch (e) {
        alert('Failed to delete consumer');
      }
    }

    async function deleteCourse(id) {
      if (!confirm('Are you sure you want to delete this course?')) return;

      try {
        await fetch('/admin/api/courses/' + id, { method: 'DELETE' });
        loadCourses();
        loadStats();
      } catch (e) {
        alert('Failed to delete course');
      }
    }

    // === Bulk Upload Functions ===

    function showBulkUploadModal() {
      document.getElementById('bulkUploadForm').reset();
      document.getElementById('bulk-upload-status').style.display = 'none';
      document.getElementById('bulk-upload-btn').disabled = false;
      document.getElementById('bulkUploadModal').classList.add('active');
    }

    document.getElementById('bulkUploadForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const statusDiv = document.getElementById('bulk-upload-status');
      const progressDiv = document.getElementById('bulk-upload-progress');
      const resultsDiv = document.getElementById('bulk-upload-results');
      const btn = document.getElementById('bulk-upload-btn');

      statusDiv.style.display = 'block';
      progressDiv.textContent = 'Uploading packages...';
      resultsDiv.innerHTML = '';
      btn.disabled = true;

      try {
        const res = await fetch('/admin/api/courses/bulk', {
          method: 'POST',
          body: formData
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Upload failed');
        }

        progressDiv.textContent = data.message;
        resultsDiv.innerHTML = data.results.map(r =>
          \`<div style="padding: 4px 0; color: \${r.success ? '#155724' : '#721c24'};">
            \${r.success ? '✓' : '✗'} \${escapeHtml(r.filename)}\${r.success ? ' → ' + escapeHtml(r.title) : ' - ' + escapeHtml(r.error)}
          </div>\`
        ).join('');

        loadCourses();
        loadStats();
      } catch (e) {
        progressDiv.textContent = 'Upload failed: ' + e.message;
      }

      btn.disabled = false;
    });

    // === Replace Course Functions ===

    function showReplaceModal(courseId, courseTitle) {
      document.getElementById('replaceCourseForm').reset();
      document.getElementById('replace-course-id').value = courseId;
      document.getElementById('replace-course-title').textContent = courseTitle;
      document.getElementById('replaceCourseModal').classList.add('active');
    }

    document.getElementById('replaceCourseForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const courseId = document.getElementById('replace-course-id').value;
      const formData = new FormData(e.target);

      try {
        const res = await fetch('/admin/api/courses/' + courseId + '/replace', {
          method: 'PUT',
          body: formData
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Replace failed');
        }

        closeModal('replaceCourseModal');
        loadCourses();
        alert('Course package replaced successfully!');
      } catch (e) {
        alert('Failed to replace course: ' + e.message);
      }
    });

    function copyToClipboard(elementId) {
      const text = document.getElementById(elementId).textContent;
      navigator.clipboard.writeText(text).then(() => {
        alert('Copied to clipboard!');
      });
    }

    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // === Suites Functions ===

    async function loadSuites() {
      try {
        const res = await fetch('/admin/api/suites');
        const suites = await res.json();
        const tbody = document.getElementById('suites-table');

        if (suites.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4" class="empty-state"><h3>No suites yet</h3><p>Create a suite to group courses for IMSCC export</p></td></tr>';
          return;
        }

        tbody.innerHTML = suites.map(s => \`
          <tr>
            <td><strong>\${escapeHtml(s.title)}</strong>\${s.description ? '<br><small style="color:#666">' + escapeHtml(s.description) + '</small>' : ''}</td>
            <td><span class="badge badge-info">\${s.course_count} courses</span></td>
            <td>\${new Date(s.created_at).toLocaleDateString()}</td>
            <td>
              <button class="btn btn-sm btn-secondary" onclick="showManageSuiteModal('\${s.id}', '\${escapeHtml(s.title).replace(/'/g, "\\\\'")}')">Manage</button>
              <button class="btn btn-sm btn-primary" onclick="showIMSCCModal('\${s.id}')">IMSCC</button>
              <button class="btn btn-sm btn-danger" onclick="deleteSuite('\${s.id}')">Delete</button>
            </td>
          </tr>
        \`).join('');
      } catch (e) {
        console.error('Failed to load suites:', e);
      }
    }

    function showCreateSuiteModal() {
      document.getElementById('createSuiteForm').reset();
      document.getElementById('createSuiteModal').classList.add('active');
    }

    document.getElementById('createSuiteForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const data = Object.fromEntries(formData.entries());

      try {
        const res = await fetch('/admin/api/suites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });

        if (!res.ok) throw new Error('Failed to create suite');

        closeModal('createSuiteModal');
        loadSuites();
        alert('Suite created successfully!');
      } catch (e) {
        alert('Failed to create suite: ' + e.message);
      }
    });

    async function showManageSuiteModal(suiteId, suiteTitle) {
      document.getElementById('manage-suite-id').value = suiteId;
      document.getElementById('manage-suite-title').textContent = 'Manage: ' + suiteTitle;

      // Load suite courses
      await loadSuiteCourses(suiteId);

      // Load available courses for dropdown
      const res = await fetch('/admin/api/courses');
      const courses = await res.json();
      const select = document.getElementById('add-course-select');
      select.innerHTML = '<option value="">Select a course to add...</option>' +
        courses.filter(c => c.active).map(c => \`<option value="\${c.id}">\${escapeHtml(c.title)}</option>\`).join('');

      document.getElementById('manageSuiteModal').classList.add('active');
    }

    async function loadSuiteCourses(suiteId) {
      try {
        const res = await fetch('/admin/api/suites/' + suiteId);
        const suite = await res.json();
        const container = document.getElementById('suite-courses-list');

        if (!suite.courses || suite.courses.length === 0) {
          container.innerHTML = '<div class="empty-state" style="padding: 24px;">No courses yet</div>';
          return;
        }

        container.innerHTML = suite.courses.map((c, i) => \`
          <div style="display: flex; align-items: center; padding: 12px 16px; border-bottom: 1px solid #eee;">
            <span style="color: #999; width: 30px;">\${i + 1}.</span>
            <span style="flex: 1;">\${escapeHtml(c.title)} <span class="badge badge-info" style="margin-left: 8px;">SCORM \${c.scorm_version}</span></span>
            <button class="btn btn-sm btn-danger" onclick="removeCourseFromSuite('\${suiteId}', '\${c.id}')">Remove</button>
          </div>
        \`).join('');
      } catch (e) {
        console.error('Failed to load suite courses:', e);
      }
    }

    async function addCourseToSuite() {
      const suiteId = document.getElementById('manage-suite-id').value;
      const courseId = document.getElementById('add-course-select').value;

      if (!courseId) {
        alert('Please select a course');
        return;
      }

      try {
        const res = await fetch('/admin/api/suites/' + suiteId + '/courses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ courseId })
        });

        if (!res.ok) throw new Error('Failed to add course');

        await loadSuiteCourses(suiteId);
        loadSuites();
        document.getElementById('add-course-select').value = '';
      } catch (e) {
        alert('Failed to add course: ' + e.message);
      }
    }

    async function removeCourseFromSuite(suiteId, courseId) {
      if (!confirm('Remove this course from the suite?')) return;

      try {
        await fetch('/admin/api/suites/' + suiteId + '/courses/' + courseId, { method: 'DELETE' });
        await loadSuiteCourses(suiteId);
        loadSuites();
      } catch (e) {
        alert('Failed to remove course');
      }
    }

    async function deleteSuite(id) {
      if (!confirm('Are you sure you want to delete this suite?')) return;

      try {
        await fetch('/admin/api/suites/' + id, { method: 'DELETE' });
        loadSuites();
      } catch (e) {
        alert('Failed to delete suite');
      }
    }

    async function showIMSCCModal(suiteId) {
      document.getElementById('imscc-suite-id').value = suiteId;

      // Load consumers for select
      const res = await fetch('/admin/api/consumers');
      const consumers = await res.json();
      const select = document.getElementById('imscc-consumer-select');
      select.innerHTML = '<option value="">Select a consumer...</option>' +
        consumers.filter(c => c.active).map(c => \`<option value="\${c.id}">\${escapeHtml(c.name)}</option>\`).join('');

      document.getElementById('imsccModal').classList.add('active');
    }

    document.getElementById('imsccForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const suiteId = document.getElementById('imscc-suite-id').value;
      const consumerId = document.getElementById('imscc-consumer-select').value;

      if (!consumerId) {
        alert('Please select a consumer');
        return;
      }

      window.location.href = '/admin/api/suites/' + suiteId + '/imscc?consumerId=' + consumerId;
      closeModal('imsccModal');
    });

    // === Settings Functions ===

    async function loadSettings() {
      try {
        const res = await fetch('/admin/api/settings');
        const settings = await res.json();
        document.getElementById('settings-base-url').value = settings.base_url || '';
      } catch (e) {
        console.error('Failed to load settings:', e);
      }
    }

    document.getElementById('settingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const data = Object.fromEntries(formData.entries());

      try {
        const res = await fetch('/admin/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to save settings');
        }

        alert('Settings saved successfully!');
      } catch (e) {
        alert('Failed to save settings: ' + e.message);
      }
    });
  </script>
</body>
</html>`;
}
