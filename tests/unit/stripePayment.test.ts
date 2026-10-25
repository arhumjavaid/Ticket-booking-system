process.env.STRIPE_SECRET_KEY = 'sk_test_unit';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_unit';

const tx = {
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
  stripeEvent: { create: jest.fn() },
  eventSeat: { updateMany: jest.fn() },
  seatHold: { updateMany: jest.fn() },
  booking: { update: jest.fn() },
  payment: { update: jest.fn(), updateMany: jest.fn() },
};

jest.mock('@ticketing/database', () => ({
  writeDB: {
    booking: { findUnique: jest.fn(), findMany: jest.fn(), findUniqueOrThrow: jest.fn() },
    stripeEvent: { createMany: jest.fn() },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
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
    BookingConfirmed: 'booking.confirmed',
    PaymentCompleted: 'payment.completed',
    PaymentFailed: 'payment.failed',
    SeatReleased: 'seat.released',
    NotificationRequested: 'notification.requested',
  },
}));

const stripeApi = {
  paymentIntents: { retrieve: jest.fn(), cancel: jest.fn() },
  refunds: { create: jest.fn() },
  webhooks: { constructEvent: jest.fn() },
};
jest.mock('stripe', () => jest.fn().mockImplementation(() => stripeApi));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { writeDB } = require('@ticketing/database');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { publishEvent } = require('@ticketing/messaging');
import { confirmPaymentIntent, abandonCheckout, handleStripeWebhook } from '@ticketing/booking-service/dist/services/paymentService';

const intent = (overrides: object = {}) => ({ id: 'pi_1', amount: 5000, status: 'succeeded', metadata: { bookingId: 'b1' }, ...overrides }) as any;
const stripeEvent = { id: 'evt_1', type: 'payment_intent.succeeded' } as any;
const booking = (overrides: object = {}) => ({
  id: 'b1',
  userId: 'u1',
  eventId: 'e1',
  status: 'PENDING',
  totalAmount: { toString: () => '50.00' },
  expiresAt: new Date(Date.now() - 1000),
  items: [{ seatId: 's1', eventSeatId: 'es1' }],
  payment: { transactionRef: 'pi_1' },
  ...overrides,
});
const routingKeys = () => publishEvent.mock.calls.map((c: unknown[]) => c[0]);

beforeEach(() => {
  jest.clearAllMocks();
  tx.stripeEvent.create.mockResolvedValue({});
  tx.eventSeat.updateMany.mockResolvedValue({ count: 1 });
  writeDB.booking.findUnique.mockResolvedValue(booking());
});

describe('Stripe webhook confirmation (HELD -> BOOKED)', () => {
  it('books the held seats, completes the payment and announces it', async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([{ status: 'PENDING' }])
      .mockResolvedValueOnce([{ id: 'es1', status: 'HELD', held_by: 'u1', version: 2 }]);

    expect(await confirmPaymentIntent(intent(), stripeEvent)).toBe('confirmed');

    expect(tx.stripeEvent.create).toHaveBeenCalledWith({ data: { id: 'evt_1', type: 'payment_intent.succeeded' } });
    expect(tx.eventSeat.updateMany).toHaveBeenCalledWith({
      where: { id: 'es1', version: 2 },
      data: { status: 'BOOKED', heldBy: null, holdExpiresAt: null, version: { increment: 1 } },
    });
    expect(tx.payment.update).toHaveBeenCalledWith({
      where: { bookingId: 'b1' },
      data: { status: 'COMPLETED', provider: 'STRIPE', transactionRef: 'pi_1' },
    });
    expect(tx.booking.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { status: 'CONFIRMED', expiresAt: null } });
    expect(routingKeys()).toEqual(expect.arrayContaining(['booking.confirmed', 'payment.completed']));
    expect(stripeApi.refunds.create).not.toHaveBeenCalled();
  });

  it('treats a redelivered Stripe event as a no-op (event id already stored)', async () => {
    tx.stripeEvent.create.mockRejectedValue({ code: 'P2002', meta: { target: ['id'] } });

    expect(await confirmPaymentIntent(intent(), stripeEvent)).toBe('duplicate');

    expect(tx.eventSeat.updateMany).not.toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('never confirms twice: an already CONFIRMED booking is left alone', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ status: 'CONFIRMED' }]);

    expect(await confirmPaymentIntent(intent())).toBe('already_confirmed');

    expect(tx.eventSeat.updateMany).not.toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['released after the window expired', 'EXPIRED', { status: 'AVAILABLE', held_by: null }, 5000],
    ['re-held by another user', 'EXPIRED', { status: 'HELD', held_by: 'u2' }, 5000],
    ['paid with a different amount', 'PENDING', { status: 'HELD', held_by: 'u1' }, 4999],
  ])('refunds instead of booking when the seat was %s', async (_label, bookingStatus, seat, amount) => {
    tx.$queryRaw
      .mockResolvedValueOnce([{ status: bookingStatus }])
      .mockResolvedValueOnce([{ id: 'es1', version: 4, ...seat }]);

    expect(await confirmPaymentIntent(intent({ amount }), stripeEvent)).toBe('refunded');

    expect(stripeApi.refunds.create).toHaveBeenCalledWith({ payment_intent: 'pi_1' }, { idempotencyKey: 'refund-pi_1' });
    expect(tx.eventSeat.updateMany).not.toHaveBeenCalled();
    expect(tx.payment.update).toHaveBeenCalledWith({ where: { bookingId: 'b1' }, data: { status: 'REFUNDED', transactionRef: 'pi_1' } });
    expect(routingKeys()).toEqual(['payment.failed', 'notification.requested']);
  });
});

describe('Ending an unpaid checkout (expiry / cancel)', () => {
  it('cancels the PaymentIntent, then returns the seats to AVAILABLE', async () => {
    stripeApi.paymentIntents.retrieve.mockResolvedValue(intent({ status: 'requires_payment_method' }));
    stripeApi.paymentIntents.cancel.mockResolvedValue(intent({ status: 'canceled' }));
    tx.$queryRaw.mockResolvedValueOnce([{ status: 'PENDING' }]);

    expect(await abandonCheckout('b1', 'EXPIRED', 'payment_window_expired')).toBe('released');

    expect(stripeApi.paymentIntents.cancel).toHaveBeenCalledWith('pi_1');
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(tx.booking.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { status: 'EXPIRED' } });
    expect(tx.seatHold.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'EXPIRED' } }));
    expect(publishEvent).toHaveBeenCalledWith('seat.released', expect.objectContaining({ seatId: 's1', reason: 'payment_window_expired' }));
  });

  it('confirms instead when Stripe says the customer already paid (missed webhook)', async () => {
    stripeApi.paymentIntents.retrieve.mockResolvedValue(intent());
    tx.$queryRaw
      .mockResolvedValueOnce([{ status: 'PENDING' }])
      .mockResolvedValueOnce([{ id: 'es1', status: 'HELD', held_by: 'u1', version: 2 }]);

    expect(await abandonCheckout('b1', 'EXPIRED', 'payment_window_expired')).toBe('confirmed');

    expect(stripeApi.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('keeps the seats while Stripe is unreachable, within the grace period', async () => {
    stripeApi.paymentIntents.retrieve.mockRejectedValue(new Error('ECONNRESET'));

    expect(await abandonCheckout('b1', 'EXPIRED', 'payment_window_expired')).toBe('pending');
    expect(writeDB.$transaction).not.toHaveBeenCalled();
  });

  it('releases anyway once the grace has passed, so seats can never stay HELD', async () => {
    writeDB.booking.findUnique.mockResolvedValue(booking({ expiresAt: new Date(Date.now() - 10 * 60 * 1000) }));
    stripeApi.paymentIntents.retrieve.mockRejectedValue(new Error('ECONNRESET'));
    tx.$queryRaw.mockResolvedValueOnce([{ status: 'PENDING' }]);

    expect(await abandonCheckout('b1', 'EXPIRED', 'payment_window_expired')).toBe('released');
  });

  it('is a no-op for a booking that is no longer PENDING', async () => {
    writeDB.booking.findUnique.mockResolvedValue(booking({ status: 'CONFIRMED' }));

    expect(await abandonCheckout('b1', 'CANCELLED', 'checkout_cancelled')).toBe('noop');
    expect(stripeApi.paymentIntents.retrieve).not.toHaveBeenCalled();
  });
});

describe('Stripe webhook endpoint', () => {
  it('explains that webhooks are optional when STRIPE_WEBHOOK_SECRET is unset', async () => {
    const prev = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET = '';
    await expect(handleStripeWebhook(Buffer.from('{}'), 'sig')).rejects.toThrow(/payment\/sync|worker Stripe poller/);
    process.env.STRIPE_WEBHOOK_SECRET = prev;
    expect(writeDB.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a payload whose signature does not verify', async () => {
    stripeApi.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature');
    });

    await expect(handleStripeWebhook(Buffer.from('{}'), 'bad')).rejects.toThrow('Invalid Stripe webhook');
    expect(writeDB.$transaction).not.toHaveBeenCalled();
  });

  it('keeps the checkout open on a declined card so the user can retry', async () => {
    stripeApi.webhooks.constructEvent.mockReturnValue({
      id: 'evt_2',
      type: 'payment_intent.payment_failed',
      data: { object: intent({ status: 'requires_payment_method' }) },
    });

    expect(await handleStripeWebhook(Buffer.from('{}'), 'sig')).toEqual({ type: 'payment_intent.payment_failed', outcome: 'ignored' });
    expect(writeDB.$transaction).not.toHaveBeenCalled();
    expect(writeDB.stripeEvent.createMany).toHaveBeenCalled();
  });
});
