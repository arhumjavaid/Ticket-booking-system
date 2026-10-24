import type { Request, Response } from 'express';
import { bookingServiceClient } from '../clients';
import { forwardServiceError } from '../proxyError';

/**
 * Public Stripe webhook endpoint. No auth here: the booking service verifies
 * the Stripe-Signature over the raw body, which is forwarded byte-for-byte.
 * A non-2xx answer makes Stripe retry, which the handler tolerates.
 */
export async function stripeWebhookProxy(req: Request, res: Response): Promise<void> {
  try {
    const response = await bookingServiceClient.post('/internal/payments/stripe/webhook', req.body, {
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': req.headers['stripe-signature'] || '' },
      transformRequest: [(data) => data],
    });
    res.status(response.status).json(response.data);
  } catch (err) {
    forwardServiceError(err, res, 'Booking service is currently unavailable');
  }
}
