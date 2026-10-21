jest.mock('@ticketing/database', () => ({
  writeDB: {
    idempotencyKey: { findUnique: jest.fn() },
    booking: { findUniqueOrThrow: jest.fn() },
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
    BookingConfirmed: 'booking.confirmed',
    PaymentCompleted: 'payment.completed',
    NotificationRequested: 'notification.requested',
  },
}));

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

    // The critical assertion: a replay must NOT re-run the seat lock or
    // the booking transaction - otherwise a retried request could race
    // against itself and double-book.
    expect(withLock).not.toHaveBeenCalled();
    expect(writeDB.$transaction).not.toHaveBeenCalled();
  });

  it('proceeds with a normal booking transaction when the key has not been seen before', async () => {
    writeDB.idempotencyKey.findUnique.mockResolvedValue(null);
    writeDB.$transaction.mockResolvedValue({
      bookingId: 'booking-999',
      totalAmount: 100,
      seats: [{ seatId: 'seat-1', price: '100.00' }],
    });

    const result = await createBooking({
      userId: 'user-1',
      eventId: 'event-1',
      seatIds: ['seat-1'],
      idempotencyKey: 'key-2',
    });

    expect(result.idempotent).toBe(false);
    expect(withLock).toHaveBeenCalledTimes(1);
    expect(writeDB.$transaction).toHaveBeenCalledTimes(1);
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
