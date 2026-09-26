import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '@ticketing/auth';
import { asyncHandler, validateBody, RATE_LIMITS } from '@ticketing/shared';
import { rateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import { bookingServiceClient } from '../clients';
import { forwardServiceError } from '../proxyError';

export const router = Router();

const holdSchema = z.object({ seatId: z.string().uuid() });

router.post(
  '/:eventId/seats/hold',
  authenticate,
  rateLimitMiddleware('hold', RATE_LIMITS.hold.limit, RATE_LIMITS.hold.windowSeconds),
  validateBody(holdSchema),
  asyncHandler(async (req, res) => {
    try {
      const response = await bookingServiceClient.post(`/internal/events/${req.params.eventId}/seats/hold`, {
        seatId: req.body.seatId,
        userId: req.user!.sub,
      });
      res.status(response.status).json(response.data);
    } catch (err) {
      forwardServiceError(err, res, 'Booking service is currently unavailable');
    }
  })
);

router.delete(
  '/:eventId/seats/hold',
  authenticate,
  validateBody(holdSchema),
  asyncHandler(async (req, res) => {
    try {
      const response = await bookingServiceClient.delete(`/internal/events/${req.params.eventId}/seats/hold`, {
        data: { seatId: req.body.seatId, userId: req.user!.sub },
      });
      res.status(response.status).json(response.data);
    } catch (err) {
      forwardServiceError(err, res, 'Booking service is currently unavailable');
    }
  })
);
