import { Router } from 'express';
import { z } from 'zod';
import { writeDB, readDB, recordAuditLog } from '@ticketing/database';
import { hashPassword, verifyPassword, signAccessToken, authenticate } from '@ticketing/auth';
import { usernameBloomFilter, cacheKeys, redis } from '@ticketing/redis';
import { attachUserToLogContext, logger } from '@ticketing/logging';
import { asyncHandler, validateBody, ConflictError, UnauthorizedError, RATE_LIMITS } from '@ticketing/shared';
import { rateLimitMiddleware } from '../middleware/rateLimitMiddleware';

export const router = Router();

const SESSION_TTL_SECONDS = 3600;

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(120),
});

router.post(
  '/register',
  validateBody(registerSchema),
  asyncHandler(async (req, res) => {
    const { email, password, name } = req.body;

    // Bloom filter optimization: only pay for a DB read when the email
    // MIGHT already be registered. A definite miss skips straight to
    // create() - correctness still comes from the DB's unique constraint.
    if (await usernameBloomFilter.mightExist(email)) {
      const existing = await writeDB.user.findUnique({ where: { email } });
      if (existing) throw new ConflictError('Email is already registered');
    }

    const passwordHash = await hashPassword(password);
    try {
      const user = await writeDB.user.create({ data: { email, passwordHash, name, role: 'USER' } });
      await usernameBloomFilter.add(email);
      recordAuditLog({ actorId: user.id, action: 'USER_REGISTERED', resourceType: 'user', resourceId: user.id, requestId: req.requestId });
      logger.info({ operation: 'register', status: 'success' }, `User registered: ${user.id}`);
      res.status(201).json({ success: true, data: { id: user.id, email: user.email, name: user.name, role: user.role } });
    } catch (err: any) {
      if (err.code === 'P2002') throw new ConflictError('Email is already registered');
      throw err;
    }
  })
);

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

router.post(
  '/login',
  rateLimitMiddleware('login', RATE_LIMITS.login.limit, RATE_LIMITS.login.windowSeconds),
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    // Bloom filter says "definitely not registered" -> reject without
    // touching the database or running bcrypt (defends against
    // credential-stuffing scans burning DB/CPU on nonexistent accounts).
    if (!(await usernameBloomFilter.mightExist(email))) {
      throw new UnauthorizedError('Invalid email or password');
    }

    const user = await readDB.run((db) => db.user.findUnique({ where: { email } }));
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new UnauthorizedError('Invalid email or password');
    }

    const { token, jti } = signAccessToken({ sub: user.id, email: user.email, role: user.role });
    await redis.set(
      cacheKeys.userSession(user.id),
      JSON.stringify({ jti, issuedAt: new Date().toISOString() }),
      'EX',
      SESSION_TTL_SECONDS
    );

    attachUserToLogContext(user.id);
    logger.info({ operation: 'login', status: 'success' }, `User logged in: ${user.id}`);

    res.status(200).json({
      success: true,
      data: { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } },
    });
  })
);

router.post(
  '/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    await redis.del(cacheKeys.userSession(req.user!.sub));
    res.status(200).json({ success: true });
  })
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await readDB.run((db) =>
      db.user.findUnique({ where: { id: req.user!.sub }, select: { id: true, email: true, name: true, role: true, createdAt: true } })
    );
    if (!user) throw new UnauthorizedError('User no longer exists');
    res.status(200).json({ success: true, data: user });
  })
);
