import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-super-secret-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';

export interface JwtPayload {
  sub: string; // user id
  email: string;
  role: 'USER' | 'ADMIN';
  jti: string;
}

/**
 * JWTs are self-contained and verified by any API instance without a
 * shared-memory session lookup, which is what keeps API servers stateless -
 * api-1, api-2 and api-3 can each verify a token signed by the others as
 * long as they share JWT_SECRET.
 */
export function signAccessToken(payload: Omit<JwtPayload, 'jti'>): { token: string; jti: string } {
  const jti = randomUUID();
  const token = jwt.sign({ ...payload, jti }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions);
  return { token, jti };
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}
