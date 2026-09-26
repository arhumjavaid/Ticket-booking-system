import { Router } from 'express';
import { z } from 'zod';
import { validateBody, asyncHandler } from '@ticketing/shared';
import { holdSeat, releaseSeatHold } from './services/holdService';
import { createBooking } from './services/bookingService';
import { cancelBooking } from './services/cancelService';

export const router = Router();

const holdSchema = z.object({ seatId: z.string().uuid(), userId: z.string().uuid() });

router.post(
  '/internal/events/:eventId/seats/hold',
  validateBody(holdSchema),
  asyncHandler(async (req, res) => {
    const result = await holdSeat({ eventId: req.params.eventId, seatId: req.body.seatId, userId: req.body.userId });
    res.status(201).json({ success: true, data: result });
  })
);

router.delete(
  '/internal/events/:eventId/seats/hold',
  validateBody(holdSchema),
  asyncHandler(async (req, res) => {
    await releaseSeatHold({ eventId: req.params.eventId, seatId: req.body.seatId, userId: req.body.userId });
    res.status(200).json({ success: true });
  })
);

const bookingSchema = z.object({
  userId: z.string().uuid(),
  eventId: z.string().uuid(),
  seatIds: z.array(z.string().uuid()).min(1).max(20),
  idempotencyKey: z.string().min(1).max(255).optional(),
});

router.post(
  '/internal/bookings',
  validateBody(bookingSchema),
  asyncHandler(async (req, res) => {
    const result = await createBooking(req.body);
    res.status(result.idempotent ? 200 : 201).json({ success: true, data: result });
  })
);

const cancelSchema = z.object({ userId: z.string().uuid(), isAdmin: z.boolean().optional() });

router.post(
  '/internal/bookings/:id/cancel',
  validateBody(cancelSchema),
  asyncHandler(async (req, res) => {
    const result = await cancelBooking({ bookingId: req.params.id, userId: req.body.userId, isAdmin: req.body.isAdmin });
    res.status(200).json({ success: true, data: result });
  })
);
