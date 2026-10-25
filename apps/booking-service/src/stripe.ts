import Stripe from 'stripe';
import { ServiceUnavailableError } from '@ticketing/shared';

export const CURRENCY = 'usd';
export const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';

let client: Stripe | null = null;

/** Lazily built so the service (and unit tests) start without Stripe keys; paying needs them. */
export function getStripe(): Stripe {
  const key = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key || key.includes('replace_me')) {
    throw new ServiceUnavailableError('Payments are not configured (set a real STRIPE_SECRET_KEY in .env and recreate booking-service)');
  }
  client ??= new Stripe(key, { maxNetworkRetries: 2, timeout: 8000 });
  return client;
}

/**
 * Webhooks are optional locally: confirmation also happens via
 * POST /bookings/:id/payment/sync and the worker's Stripe poller.
 * Only the webhook HTTP route needs this secret.
 */
export function webhookSecret(): string | null {
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!secret || secret.includes('replace_me')) return null;
  return secret;
}

export function toCents(amount: number | string | { toString(): string }): number {
  return Math.round(Number(amount.toString()) * 100);
}
