import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

// Runtime-configurable settings (can be updated via admin UI)
const runtimeConfig = {
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
};

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  get baseUrl() {
    return runtimeConfig.baseUrl;
  },

  database: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/scorm_lti_proxy',
  },

  content: {
    dir: process.env.CONTENT_DIR || path.join(process.cwd(), 'content'),
    maxUploadSize: process.env.UPLOAD_MAX_SIZE || '100mb',
  },

  xapi: {
    endpoint: process.env.XAPI_LRS_ENDPOINT || '',
    key: process.env.XAPI_LRS_KEY || '',
    secret: process.env.XAPI_LRS_SECRET || '',
  },

  session: {
    secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  },

  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin123',
  },

  isDev: process.env.NODE_ENV !== 'production',
};

/**
 * Update runtime configuration settings
 */
export function updateRuntimeConfig(updates: { baseUrl?: string }) {
  if (updates.baseUrl) {
    runtimeConfig.baseUrl = updates.baseUrl;
  }
}
