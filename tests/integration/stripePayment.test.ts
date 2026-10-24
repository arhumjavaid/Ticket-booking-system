import '../setupIntegrationEnv';
import axios from 'axios';
import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { signAccessToken } from '@ticketing/auth';
import { writeDB } from '@ticketing/database';

// Full hold -> pay -> confirm journey through Nginx against Stripe TEST mode.
// Needs the stack up plus STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET (the
// same values docker-compose passes to booking-service).
const BASE_URL = process.env.API_BASE_URL || 'http://localhost:8080/api';
const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET } = process.env;
const run = STRIPE_SECRET_KEY && STRIPE_WEBHOOK_SECRET ? describe : describe.skip;

const stripe = new Stripe(STRIPE_SECRET_KEY || 'sk_test_missing');
const client = axios.create({ baseURL: BASE_URL, validateStatus: () => true });

async function newUser() {
  const email = `pay-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const res = await client.post('/auth/register', { email, password: 'Password123!', name: 'Payer' });
  expect(res.status).toBe(201);
  return { Authorization: `Bearer ${signAccessToken({ sub: res.data.data.id, email, role: 'USER' }).token}` };
}

async function checkout(headers: Record<string, string>) {
  const events = await client.get('/events');
  const eventId = events.data.data[0].id;
  const seats = await client.get(`/events/${eventId}/seats`);
  const seatId = seats.data.data.find((s: any) => s.status === 'AVAILABLE').seatId;
  expect((await client.post(`/events/${eventId}/seats/hold`, { seatId }, { headers })).status).toBe(201);
  const res = await client.post('/bookings', { eventId, seatIds: [seatId] }, { headers: { ...headers, 'Idempotency-Key': randomUUID() } });
  expect(res.status).toBe(201);
  expect(res.data.data.status).toBe('PENDING');
  const intentId = res.data.data.payment.clientSecret.split('_secret_')[0];
  return { eventId, seatId, bookingId: res.data.data.id as string, intentId };
}

async function sendWebhook(type: string, intent: Stripe.PaymentIntent, id = `evt_test_${randomUUID()}`) {
  const payload = JSON.stringify({ id, object: 'event', type, data: { object: intent }, created: Math.floor(Date.now() / 1000), livemode: false });
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: STRIPE_WEBHOOK_SECRET! });
  return client.post('/payments/stripe/webhook', payload, {
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
    transformRequest: [(d) => d],
  });
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 25000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await fn();
  while (!ok(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    value = await fn();
  }
  return value;
}

const seatStatus = async (eventId: string, seatId: string) =>
  (await client.get(`/events/${eventId}/seats`)).data.data.find((s: any) => s.seatId === seatId).status;

run('Stripe payment lifecycle (through Nginx, Stripe test mode)', () => {
  jest.setTimeout(90000);
  afterAll(() => writeDB.$disconnect());

  it('rejects a webhook whose signature does not verify', async () => {
    const res = await client.post('/payments/stripe/webhook', '{"id":"evt_forged"}', {
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=forged' },
      transformRequest: [(d) => d],
    });
    expect(res.status).toBe(400);
  });

  it('confirms on a verified payment_intent.succeeded, once, even when Stripe redelivers', async () => {
    const headers = await newUser();
    const { eventId, seatId, bookingId, intentId } = await checkout(headers);

    const paid = await stripe.paymentIntents.confirm(intentId, { payment_method: 'pm_card_visa' });
    expect(paid.status).toBe('succeeded');

    const eventId1 = `evt_test_${randomUUID()}`;
    expect((await sendWebhook('payment_intent.succeeded', paid, eventId1)).status).toBe(200);
    const replay = await sendWebhook('payment_intent.succeeded', paid, eventId1);
    expect(replay.status).toBe(200);
    expect(replay.data.outcome).toMatch(/duplicate|already_confirmed/);

    const booking = await client.get(`/bookings/${bookingId}`, { headers });
    expect(booking.data.data.status).toBe('CONFIRMED');
    expect(booking.data.data.payment).toMatchObject({ status: 'COMPLETED', provider: 'STRIPE', transactionRef: intentId });
    expect(await seatStatus(eventId, seatId)).toBe('BOOKED');

    // Cancelling a paid booking refunds it through Stripe and frees the seat.
    expect((await client.post(`/bookings/${bookingId}/cancel`, {}, { headers })).status).toBe(200);
    const refunds = await stripe.refunds.list({ payment_intent: intentId });
    expect(refunds.data.length).toBe(1);
    expect(await waitFor(() => seatStatus(eventId, seatId), (s) => s === 'AVAILABLE')).toBe('AVAILABLE');
  });

  it('releases the seats when the PaymentIntent is canceled', async () => {
    const headers = await newUser();
    const { eventId, seatId, bookingId, intentId } = await checkout(headers);

    const canceled = await stripe.paymentIntents.cancel(intentId);
    expect((await sendWebhook('payment_intent.canceled', canceled)).status).toBe(200);

    const booking = await client.get(`/bookings/${bookingId}`, { headers });
    expect(booking.data.data.status).toBe('FAILED');
    expect(await seatStatus(eventId, seatId)).toBe('AVAILABLE');
  });

  it('expires an unpaid checkout once its window closes: PaymentIntent canceled, seat for sale again', async () => {
    const headers = await newUser();
    const { eventId, seatId, bookingId, intentId } = await checkout(headers);

    // Fast-forward the payment window instead of waiting SEAT_HOLD_TTL_SECONDS.
    const past = new Date(Date.now() - 60_000);
    await writeDB.booking.update({ where: { id: bookingId }, data: { expiresAt: past } });
    await writeDB.seatHold.updateMany({ where: { eventId, seatId, status: 'ACTIVE' }, data: { expiresAt: past } });

    const booking = await waitFor(() => client.get(`/bookings/${bookingId}`, { headers }), (r) => r.data.data.status !== 'PENDING');
    expect(booking.data.data.status).toBe('EXPIRED');
    expect((await stripe.paymentIntents.retrieve(intentId)).status).toBe('canceled');
    expect(await seatStatus(eventId, seatId)).toBe('AVAILABLE');
  });

  it('a payment that succeeded in the window is confirmed by the worker even if the webhook never arrives', async () => {
    const headers = await newUser();
    const { bookingId, intentId } = await checkout(headers);
    await stripe.paymentIntents.confirm(intentId, { payment_method: 'pm_card_visa' });
    await writeDB.booking.update({ where: { id: bookingId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const booking = await waitFor(() => client.get(`/bookings/${bookingId}`, { headers }), (r) => r.data.data.status !== 'PENDING');
    expect(booking.data.data.status).toBe('CONFIRMED');
  });
});
