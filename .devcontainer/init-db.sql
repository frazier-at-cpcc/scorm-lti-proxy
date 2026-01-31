-- Initial database setup for SCORM-LTI Proxy
-- This runs automatically when the PostgreSQL container starts

-- Create extension for UUID generation (if not exists)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Tables are created by the application on startup
-- This file can be used for seed data during development

-- Example: Create a test consumer for development
-- INSERT INTO consumers (name, lti_consumer_key, lti_consumer_secret)
-- VALUES ('Test LMS', 'test_key_12345', 'test_secret_67890')
-- ON CONFLICT DO NOTHING;
