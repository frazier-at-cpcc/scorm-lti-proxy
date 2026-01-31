import { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

// Extend Express Session
declare module 'express-session' {
  interface SessionData {
    authenticated?: boolean;
    username?: string;
  }
}

/**
 * Middleware to require authentication for protected routes
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.session?.authenticated) {
    return next();
  }

  // Check if it's an API request or browser request
  const acceptsHtml = req.accepts('html');
  const isApiRequest = req.path.startsWith('/api/') || req.xhr;

  if (isApiRequest || !acceptsHtml) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Redirect to login page for browser requests
  res.redirect('/admin/login');
}

/**
 * Login handler
 */
export function handleLogin(req: Request, res: Response) {
  const { username, password } = req.body;

  if (username === config.admin.username && password === config.admin.password) {
    req.session.authenticated = true;
    req.session.username = username;

    // Check if it's an API request
    if (req.accepts('json') && !req.accepts('html')) {
      return res.json({ success: true });
    }

    // Redirect to dashboard
    const redirectTo = (req.query.redirect as string) || '/admin';
    res.redirect(redirectTo);
  } else {
    if (req.accepts('json') && !req.accepts('html')) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    res.redirect('/admin/login?error=invalid');
  }
}

/**
 * Logout handler
 */
export function handleLogout(req: Request, res: Response) {
  req.session.destroy((err) => {
    if (err) {
      console.error('Session destroy error:', err);
    }

    if (req.accepts('json') && !req.accepts('html')) {
      return res.json({ success: true });
    }

    res.redirect('/admin/login');
  });
}

/**
 * Check auth status (for API)
 */
export function checkAuthStatus(req: Request, res: Response) {
  res.json({
    authenticated: !!req.session?.authenticated,
    username: req.session?.username || null,
  });
}
