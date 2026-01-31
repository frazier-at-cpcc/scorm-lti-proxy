import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { config } from '../config.js';
import { query } from '../db/index.js';
import { extractScormPackage, parseManifest } from '../services/content-manager.js';
import { generateDispatchPackage } from '../services/dispatch-generator.js';
import { requireAuth, handleLogin, handleLogout, checkAuthStatus } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

export const adminRouter = Router();

// File upload configuration
const upload = multer({
  dest: path.join(process.cwd(), 'uploads'),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
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

// List courses
adminRouter.get('/api/courses', requireAuth, async (_req: Request, res: Response) => {
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

// Delete course
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

    // Soft delete
    await query('UPDATE courses SET active = false WHERE id = $1', [id]);

    res.json({ success: true });
  } catch (error) {
    console.error('Delete course error:', error);
    res.status(500).json({ error: 'Failed to delete course' });
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
      <button class="tab" data-panel="launches">Launch History</button>
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
          <button class="btn btn-primary" onclick="showUploadCourseModal()">Upload Course</button>
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
  </script>
</body>
</html>`;
}
