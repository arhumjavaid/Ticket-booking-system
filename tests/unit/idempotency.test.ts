process.env.STRIPE_SECRET_KEY = 'sk_test_unit';

jest.mock('@ticketing/database', () => ({
  writeDB: {
    idempotencyKey: { findUnique: jest.fn() },
    booking: { findUniqueOrThrow: jest.fn() },
    payment: { update: jest.fn() },
    $transaction: jest.fn(),
  },
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    join: (arr: unknown[]) => arr,
  },
}));

jest.mock('@ticketing/redis', () => ({
  withLock: jest.fn((_resource: string, _ttl: number, fn: () => unknown) => fn()),
  cacheInvalidate: jest.fn(),
  cacheKeys: {
    eventAvailability: (id: string) => `event:${id}:availability`,
    seatStatus: (e: string, s: string) => `seat:${e}:${s}`,
  },
  bookingBloomFilter: { add: jest.fn() },
  LockAcquisitionError: class LockAcquisitionError extends Error {},
}));

jest.mock('@ticketing/messaging', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
  RoutingKey: {
    BookingCreated: 'booking.created',
    SeatHeld: 'seat.held',
    BookingConfirmed: 'booking.confirmed',
    PaymentCompleted: 'payment.completed',
    NotificationRequested: 'notification.requested',
  },
}));

const stripeApi = { paymentIntents: { create: jest.fn().mockResolvedValue({ id: 'pi_1', client_secret: 'pi_1_secret_x' }) } };
jest.mock('stripe', () => jest.fn().mockImplementation(() => stripeApi));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { writeDB } = require('@ticketing/database');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { withLock } = require('@ticketing/redis');
import * as crypto from 'crypto';
import { createBooking } from '@ticketing/booking-service/dist/services/bookingService';

const hashOf = (userId: string, eventId: string, seatIds: string[]) =>
  crypto.createHash('sha256').update(JSON.stringify({ userId, eventId, seatIds })).digest('hex');

describe('Booking idempotency (section 17 / RULE 5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('replays the original booking instead of creating a second one for a repeated Idempotency-Key', async () => {
    writeDB.idempotencyKey.findUnique.mockResolvedValue({
      key: 'key-1',
      bookingId: 'booking-123',
      userId: 'user-1',
      requestHash: hashOf('user-1', 'event-1', ['seat-1']),
    });
    writeDB.booking.findUniqueOrThrow.mockResolvedValue({
      id: 'booking-123',
      status: 'CONFIRMED',
      eventId: 'event-1',
      totalAmount: { toFixed: () => '100.00' },
      items: [{ seatId: 'seat-1', price: { toFixed: () => '100.00' } }],
    });

    const result = await createBooking({
      userId: 'user-1',
      eventId: 'event-1',
      seatIds: ['seat-1'],
      idempotencyKey: 'key-1',
    });

    expect(result.idempotent).toBe(true);
    expect(result.id).toBe('booking-123');
    expect(result.payment).toBeNull(); // already settled: nothing left to pay

    // The critical assertion: a replay must NOT re-run the seat lock or
    // the booking transaction - otherwise a retried request could race
    // against itself and double-book.
    expect(withLock).not.toHaveBeenCalled();
    expect(writeDB.$transaction).not.toHaveBeenCalled();
  });

  it('proceeds with a normal booking transaction when the key has not been seen before', async () => {
    writeDB.idempotencyKey.findUnique.mockResolvedValue(null);
    writeDB.$transaction.mockResolvedValue({
      totalAmount: 100,
      seats: [{ seatId: 'seat-1', price: '100.00' }],
      expiresAt: new Date(Date.now() + 300_000),
      newlyHeld: [],
    });

    const result = await createBooking({
      userId: 'user-1',
      eventId: 'event-1',
      seatIds: ['seat-1'],
      idempotencyKey: 'key-2',
    });

    expect(result.idempotent).toBe(false);
    expect(result.status).toBe('PENDING'); // confirmed only by the Stripe webhook
    expect(result.payment?.clientSecret).toBe('pi_1_secret_x');
    expect(withLock).toHaveBeenCalledTimes(1);
    expect(writeDB.$transaction).toHaveBeenCalledTimes(1);
    // Stripe-side idempotency: a retry can never open a second PaymentIntent.
    expect(stripeApi.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 10000, currency: 'usd', metadata: expect.objectContaining({ bookingId: result.id }) }),
      { idempotencyKey: `booking-${result.id}` }
    );
  });

  it.each([
    ['another user', { userId: 'user-2', seatIds: ['seat-1'] }],
    ['different seats', { userId: 'user-1', seatIds: ['seat-2'] }],
  ])('rejects a reused key from %s instead of returning the stored booking', async (_label, req) => {
    writeDB.idempotencyKey.findUnique.mockResolvedValue({
      key: 'key-1',
      bookingId: 'booking-123',
      userId: 'user-1',
      requestHash: hashOf('user-1', 'event-1', ['seat-1']),
    });

    await expect(createBooking({ eventId: 'event-1', idempotencyKey: 'key-1', ...req })).rejects.toThrow(
      'Idempotency-Key has already been used for a different request'
    );
    expect(writeDB.booking.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(writeDB.$transaction).not.toHaveBeenCalled();
  });
});
