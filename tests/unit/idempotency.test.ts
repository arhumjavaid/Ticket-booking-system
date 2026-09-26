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
  decrementAvailability: jest.fn(),
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
import { createBooking } from '@ticketing/booking-service/dist/services/bookingService';

describe('Booking idempotency (section 17 / RULE 5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('replays the original booking instead of creating a second one for a repeated Idempotency-Key', async () => {
    writeDB.idempotencyKey.findUnique.mockResolvedValue({ key: 'key-1', bookingId: 'booking-123' });
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
});
