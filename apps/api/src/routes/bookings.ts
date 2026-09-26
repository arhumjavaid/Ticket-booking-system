import { Router } from 'express';
import { z } from 'zod';
import { readDB } from '@ticketing/database';
import { authenticate } from '@ticketing/auth';
import { bookingBloomFilter } from '@ticketing/redis';
import { asyncHandler, validateBody, ValidationError, ForbiddenError, NotFoundError, RATE_LIMITS } from '@ticketing/shared';
import { rateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import { bookingServiceClient } from '../clients';
import { forwardServiceError } from '../proxyError';

export const router = Router();

const createBookingSchema = z.object({
  eventId: z.string().uuid(),
  seatIds: z.array(z.string().uuid()).min(1).max(20),
});

router.post(
  '/',
  authenticate,
  rateLimitMiddleware('booking', RATE_LIMITS.booking.limit, RATE_LIMITS.booking.windowSeconds),
  validateBody(createBookingSchema),
  asyncHandler(async (req, res) => {
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      throw new ValidationError('Idempotency-Key header is required for booking requests');
    }

    try {
      const response = await bookingServiceClient.post('/internal/bookings', {
        userId: req.user!.sub,
        eventId: req.body.eventId,
        seatIds: req.body.seatIds,
        idempotencyKey,
      });
      res.status(response.status).json(response.data);
    } catch (err) {
      forwardServiceError(err, res, 'Booking service is currently unavailable');
    }
  })
);

router.get(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const page = Math.max(parseInt(String(req.query.page || '1'), 10), 1);
    const pageSize = Math.min(Math.max(parseInt(String(req.query.pageSize || '20'), 10), 1), 100);
    const viewAll = req.user!.role === 'ADMIN' && req.query.all === 'true';

    const where = viewAll ? {} : { userId: req.user!.sub };
    const [bookings, total] = await readDB.run((db) =>
      Promise.all([
        db.booking.findMany({
          where,
          include: { items: true, event: { select: { id: true, name: true, startsAt: true } }, payment: true },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        db.booking.count({ where }),
      ])
    );

    res.status(200).json({ success: true, data: bookings, pagination: { page, pageSize, total } });
  })
);

router.get(
  '/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    if (!(await bookingBloomFilter.mightExist(req.params.id))) {
      throw new NotFoundError('Booking');
    }

    const booking = await readDB.run((db) =>
      db.booking.findUnique({
        where: { id: req.params.id },
        include: { items: true, event: true, payment: true },
      })
    );
    if (!booking) throw new NotFoundError('Booking');
    if (booking.userId !== req.user!.sub && req.user!.role !== 'ADMIN') {
      throw new ForbiddenError('You do not have access to this booking');
    }
    res.status(200).json({ success: true, data: booking });
  })
);

router.post(
  '/:id/cancel',
  authenticate,
  asyncHandler(async (req, res) => {
    try {
      const response = await bookingServiceClient.post(`/internal/bookings/${req.params.id}/cancel`, {
        userId: req.user!.sub,
        isAdmin: req.user!.role === 'ADMIN',
      });
      res.status(response.status).json(response.data);
    } catch (err) {
      forwardServiceError(err, res, 'Booking service is currently unavailable');
    }
  })
);
