import pg from 'pg';
import { config, updateRuntimeConfig } from '../config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.database.url,
});

export async function initDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    // Test connection
    await client.query('SELECT NOW()');
    console.log('Database connected successfully');

    // Create tables if they don't exist
    await client.query(`
      -- Consumers (LTI Tool Consumers / Customers)
      CREATE TABLE IF NOT EXISTS consumers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        lti_consumer_key VARCHAR(255) UNIQUE NOT NULL,
        lti_consumer_secret VARCHAR(255) NOT NULL,
        xapi_lrs_endpoint VARCHAR(500),
        xapi_lrs_key VARCHAR(255),
        xapi_lrs_secret VARCHAR(255),
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Courses (SCORM Content)
      CREATE TABLE IF NOT EXISTS courses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(255) NOT NULL,
        description TEXT,
        scorm_version VARCHAR(20) NOT NULL,
        launch_path VARCHAR(500) NOT NULL,
        manifest_data JSONB,
        content_path VARCHAR(500) NOT NULL,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Launches (LTI Launch Context)
      CREATE TABLE IF NOT EXISTS launches (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        consumer_id UUID REFERENCES consumers(id),
        course_id UUID REFERENCES courses(id),
        user_id VARCHAR(255) NOT NULL,
        context_id VARCHAR(255),
        resource_link_id VARCHAR(255),
        lis_outcome_service_url VARCHAR(500),
        lis_result_sourcedid VARCHAR(500),
        launch_data JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Attempts (SCORM Session Data)
      CREATE TABLE IF NOT EXISTS attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        launch_id UUID REFERENCES launches(id),
        cmi_data JSONB DEFAULT '{}',
        score DECIMAL(5,2),
        completion_status VARCHAR(50) DEFAULT 'not attempted',
        success_status VARCHAR(50),
        total_time VARCHAR(50),
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        finished_at TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Dispatch Tokens (for SCORM dispatch package launches)
      CREATE TABLE IF NOT EXISTS dispatch_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        consumer_id UUID REFERENCES consumers(id),
        course_id UUID REFERENCES courses(id),
        token VARCHAR(255) UNIQUE NOT NULL,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Suites (Course Collections for IMSCC export)
      CREATE TABLE IF NOT EXISTS suites (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(255) NOT NULL,
        description TEXT,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Suite Courses (Junction table with ordering)
      CREATE TABLE IF NOT EXISTS suite_courses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        suite_id UUID REFERENCES suites(id) ON DELETE CASCADE,
        course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(suite_id, course_id)
      );

      -- Settings (Key-Value store for runtime configuration)
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(255) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_launches_user ON launches(user_id, course_id);
      CREATE INDEX IF NOT EXISTS idx_attempts_launch ON attempts(launch_id);
      CREATE INDEX IF NOT EXISTS idx_dispatch_tokens_token ON dispatch_tokens(token);
      CREATE INDEX IF NOT EXISTS idx_suite_courses_suite ON suite_courses(suite_id);
    `);

    console.log('Database tables initialized');
  } finally {
    client.release();
  }
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

/**
 * Load settings from database and update runtime config
 */
export async function loadSettings(): Promise<void> {
  try {
    const result = await pool.query<{ key: string; value: string }>(
      'SELECT key, value FROM settings'
    );

    for (const row of result.rows) {
      if (row.key === 'base_url') {
        updateRuntimeConfig({ baseUrl: row.value });
        console.log(`Loaded base_url from database: ${row.value}`);
      }
    }
  } catch (error) {
    // Settings table might not exist yet on first run
    console.log('No saved settings found, using defaults');
  }
}
