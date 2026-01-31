import express from 'express';
import cors from 'cors';
import path from 'path';
import { config } from './config.js';
import { ltiRouter } from './routes/lti.js';
import { dispatchRouter } from './routes/dispatch.js';
import { scormApiRouter } from './routes/scorm-api.js';
import { adminRouter } from './routes/admin.js';
import { initDatabase } from './db/index.js';

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (SCORM player, extracted content)
app.use('/static', express.static(path.join(process.cwd(), 'src', 'public')));
app.use('/content', express.static(config.content.dir));

// Routes
app.use('/lti', ltiRouter);
app.use('/dispatch', dispatchRouter);
app.use('/api/scorm', scormApiRouter);
app.use('/admin', adminRouter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({ error: err.message });
});

async function start() {
  try {
    await initDatabase();
    app.listen(config.port, () => {
      console.log(`SCORM-LTI Proxy server running on port ${config.port}`);
      console.log(`Base URL: ${config.baseUrl}`);
      console.log(`Environment: ${config.nodeEnv}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
