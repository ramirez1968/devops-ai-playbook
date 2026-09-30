import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// Tokens are issued by the auth service; every service verifies them with
// the same JWT_SECRET. Read lazily so dotenv has loaded; index.ts calls
// jwtSecret() at startup to fail fast.
export function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be set (at least 32 characters)');
  }
  return secret;
}

// Verifies the access token and puts { userId, email, role } in res.locals.user.
export function requireUser(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }
  try {
    const claims = jwt.verify(token, jwtSecret()) as any;
    if (claims.type !== 'access') throw new Error('not an access token');
    res.locals.user = { userId: claims.userId, email: claims.email, role: claims.role };
    next();
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (res.locals.user?.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin role required' });
  }
  next();
}
