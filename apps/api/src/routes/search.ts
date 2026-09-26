import { Router } from 'express';
import { asyncHandler, RATE_LIMITS } from '@ticketing/shared';
import { rateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import { searchServiceClient } from '../clients';
import { forwardServiceError } from '../proxyError';

export const router = Router();

router.get(
  '/events',
  rateLimitMiddleware('browse', RATE_LIMITS.browse.limit, RATE_LIMITS.browse.windowSeconds),
  asyncHandler(async (req, res) => {
    try {
      const response = await searchServiceClient.get('/search/events', { params: req.query });
      res.status(200).json(response.data);
    } catch (err) {
      forwardServiceError(err, res, 'Search is temporarily unavailable, please try browsing events directly');
    }
  })
);
