import jwt from 'jsonwebtoken';

const ACCESS_TOKEN_TTL = '1h';
const REFRESH_TOKEN_TTL = '7d';

export interface AccessClaims {
  userId: string;
  email: string;
  role: string;
  type: 'access';
}

interface RefreshClaims {
  userId: string;
  type: 'refresh';
}

// Read lazily so dotenv has loaded; index.ts calls this at startup to fail fast.
export function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be set (at least 32 characters)');
  }
  return secret;
}

export function issueTokens(user: { id: string; email: string; role: string }) {
  const access: AccessClaims = { userId: user.id, email: user.email, role: user.role, type: 'access' };
  const refresh: RefreshClaims = { userId: user.id, type: 'refresh' };
  return {
    token: jwt.sign(access, jwtSecret(), { expiresIn: ACCESS_TOKEN_TTL }),
    refreshToken: jwt.sign(refresh, jwtSecret(), { expiresIn: REFRESH_TOKEN_TTL }),
  };
}

// Returns the claims, or null if the token is missing, invalid, expired, or the wrong type.
export function verifyToken(token: string | undefined, type: 'access' | 'refresh'): any | null {
  if (!token) return null;
  try {
    const claims = jwt.verify(token, jwtSecret()) as any;
    return claims.type === type ? claims : null;
  } catch {
    return null;
  }
}

export function bearerToken(header: string | undefined): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}
