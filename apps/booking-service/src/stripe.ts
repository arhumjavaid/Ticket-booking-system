import Stripe from 'stripe';
import { ServiceUnavailableError } from '@ticketing/shared';

export const CURRENCY = 'usd';
export const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';

let client: Stripe | null = null;

/** Lazily built so the service (and unit tests) start without Stripe keys; paying needs them. */
export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new ServiceUnavailableError('Payments are not configured (STRIPE_SECRET_KEY is unset)');
  client ??= new Stripe(key, { maxNetworkRetries: 2, timeout: 8000 });
  return client;
}

export function webhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new ServiceUnavailableError('Stripe webhooks are not configured (STRIPE_WEBHOOK_SECRET is unset)');
  return secret;
}

export function toCents(amount: number | string | { toString(): string }): number {
  return Math.round(Number(amount.toString()) * 100);
}
