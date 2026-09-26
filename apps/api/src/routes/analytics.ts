import { Router } from 'express';
import { authenticate, authorize } from '@ticketing/auth';
import { asyncHandler } from '@ticketing/shared';
import { analyticsServiceClient } from '../clients';
import { forwardServiceError } from '../proxyError';

export const router = Router();

router.get(
  '/events/:eventId',
  authenticate,
  authorize('ADMIN'),
  asyncHandler(async (req, res) => {
    try {
      const response = await analyticsServiceClient.get(`/analytics/events/${req.params.eventId}`);
      res.status(200).json(response.data);
    } catch (err) {
      forwardServiceError(err, res, 'Analytics service is currently unavailable');
    }
  })
);

router.get(
  '/dashboard',
  authenticate,
  authorize('ADMIN'),
  asyncHandler(async (req, res) => {
    try {
      const response = await analyticsServiceClient.get('/analytics/dashboard');
      res.status(200).json(response.data);
    } catch (err) {
      forwardServiceError(err, res, 'Analytics service is currently unavailable');
    }
  })
);
