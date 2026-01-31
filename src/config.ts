import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',

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

  isDev: process.env.NODE_ENV !== 'production',
};
