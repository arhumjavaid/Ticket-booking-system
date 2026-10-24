import { Router } from 'express';
import { readDB } from '@ticketing/database';
import { authenticate, authorize } from '@ticketing/auth';
import { asyncHandler } from '@ticketing/shared';
import { projectionServiceClient } from '../clients';
import { forwardServiceError } from '../proxyError';

export const router = Router();

router.use(authenticate, authorize('ADMIN'));

router.get(
  '/users',
  asyncHandler(async (req, res) => {
    const page = Math.max(parseInt(String(req.query.page || '1'), 10), 1);
    const pageSize = Math.min(Math.max(parseInt(String(req.query.pageSize || '50'), 10), 1), 200);

    const [users, total] = await readDB.run((db) =>
      Promise.all([
        db.user.findMany({
          select: { id: true, email: true, name: true, role: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        db.user.count(),
      ])
    );

    res.status(200).json({ success: true, data: users, pagination: { page, pageSize, total } });
  })
);

// Neo4j relationship view (buyers -> bookings -> events -> venues) for one event.
router.get(
  '/graph/events/:eventId',
  asyncHandler(async (req, res) => {
    try {
      const response = await projectionServiceClient.get(`/graph/events/${req.params.eventId}`);
      res.status(200).json(response.data);
    } catch (err) {
      forwardServiceError(err, res, 'Graph view is temporarily unavailable');
    }
  })
);
