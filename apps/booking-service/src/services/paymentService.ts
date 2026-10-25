import type Stripe from 'stripe';
import { writeDB, Prisma } from '@ticketing/database';
import { cacheInvalidate, cacheKeys } from '@ticketing/redis';
import { publishEvent, RoutingKey } from '@ticketing/messaging';
import { logger } from '@ticketing/logging';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@ticketing/shared';
import { getStripe, webhookSecret, toCents } from '../stripe';
import { lockResource, withNestedLocks, isUniqueConstraintViolation } from './bookingService';

// After a payment window closes, a checkout whose Stripe state can't be
// settled (Stripe unreachable, PaymentIntent stuck "processing") is released
// anyway once this grace passes, so seats can never stay HELD indefinitely.
// A payment that still succeeds afterwards is refunded by the webhook.
const STRIPE_SETTLE_GRACE_MS = parseInt(process.env.STRIPE_SETTLE_GRACE_SECONDS || '120', 10) * 1000;

type ConfirmOutcome = 'confirmed' | 'already_confirmed' | 'refunded' | 'duplicate' | 'unknown';
type FinalStatus = 'EXPIRED' | 'FAILED' | 'CANCELLED';

/** Verifies the Stripe signature over the raw body, then applies the event. */
export async function handleStripeWebhook(rawBody: Buffer, signature: string | undefined): Promise<{ type: string; outcome: string }> {
  const secret = webhookSecret();
  if (!secret) {
    throw new ValidationError(
      'Stripe webhooks are not configured. Local confirmation uses payment/sync + the worker Stripe poller instead.'
    );
  }
  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature || '', secret);
  } catch (err) {
    throw new ValidationError(`Invalid Stripe webhook: ${(err as Error).message}`);
  }

  const intent = event.data.object as Stripe.PaymentIntent;
  let outcome = 'ignored';
  switch (event.type) {
    case 'payment_intent.succeeded':
      outcome = await confirmPaymentIntent(intent, event);
      break;
    case 'payment_intent.canceled':
      if (intent.metadata?.bookingId) outcome = String(await releaseCheckout(intent.metadata.bookingId, 'FAILED', 'payment_canceled'));
      break;
    case 'payment_intent.payment_failed':
      // A declined card is not terminal: the Payment Element lets the user
      // retry on the same PaymentIntent while the hold lasts. The seats go
      // back when the window closes (worker) or the user cancels.
      logger.info({ operation: 'stripeWebhook', bookingId: intent.metadata?.bookingId, status: 'payment_attempt_failed' }, intent.last_payment_error?.message || 'Payment attempt failed');
      break;
  }
  if (outcome !== 'duplicate') {
    await writeDB.stripeEvent.createMany({ data: [{ id: event.id, type: event.type }], skipDuplicates: true });
  }
  return { type: event.type, outcome };
}

/**
 * HELD -> BOOKED for a succeeded PaymentIntent. Same lock + transaction +
 * version guard as every other seat mutation, and idempotent three ways:
 * the Stripe event id is inserted inside the transaction (a redelivery hits
 * the primary key), the booking row is locked and must still be PENDING,
 * and Stripe refunds use an idempotency key.
 *
 * If the seats are no longer this booking's (the window expired and they
 * were released, maybe re-sold) the money is refunded instead - a late
 * payment must never book a seat twice.
 */
export async function confirmPaymentIntent(intent: Stripe.PaymentIntent, stripeEvent?: Stripe.Event): Promise<ConfirmOutcome> {
  const bookingId = intent.metadata?.bookingId;
  const booking = bookingId ? await writeDB.booking.findUnique({ where: { id: bookingId }, include: { items: true, payment: true } }) : null;
  if (!booking || !booking.payment) {
    logger.warn({ operation: 'confirmPayment', paymentIntentId: intent.id, status: 'unknown_booking' }, 'PaymentIntent has no matching booking');
    return 'unknown';
  }
  const seatIds = booking.items.map((i) => i.seatId).sort();

  let outcome: ConfirmOutcome;
  try {
    outcome = await withNestedLocks(seatIds.map((s) => lockResource(booking.eventId, s)), () =>
      writeDB.$transaction(async (tx) => {
        if (stripeEvent) await tx.stripeEvent.create({ data: { id: stripeEvent.id, type: stripeEvent.type } });

        const [locked] = await tx.$queryRaw<{ status: string }[]>(Prisma.sql`
          SELECT status FROM bookings WHERE id = ${booking.id} FOR UPDATE
        `);
        if (locked.status === 'CONFIRMED') return 'already_confirmed' as const;

        const seats = await tx.$queryRaw<{ id: string; status: string; held_by: string | null; version: number }[]>(Prisma.sql`
          SELECT id, status, held_by, version FROM event_seats
          WHERE id IN (${Prisma.join(booking.items.map((i) => i.eventSeatId))})
          FOR UPDATE
        `);
        const stillOurs =
          locked.status === 'PENDING' &&
          seats.length === booking.items.length &&
          seats.every((s) => s.status === 'HELD' && s.held_by === booking.userId) &&
          intent.amount === toCents(booking.totalAmount);

        if (!stillOurs) {
          // Inside the transaction on purpose: if the refund call fails the
          // event-id insert rolls back too, so Stripe's retry refunds again.
          await getStripe().refunds.create({ payment_intent: intent.id }, { idempotencyKey: `refund-${intent.id}` });
          if (locked.status === 'PENDING') await tx.booking.update({ where: { id: booking.id }, data: { status: 'FAILED' } });
          await tx.payment.update({ where: { bookingId: booking.id }, data: { status: 'REFUNDED', transactionRef: intent.id } });
          return 'refunded' as const;
        }

        for (const seat of seats) {
          const update = await tx.eventSeat.updateMany({
            where: { id: seat.id, version: seat.version },
            data: { status: 'BOOKED', heldBy: null, holdExpiresAt: null, version: { increment: 1 } },
          });
          if (update.count === 0) throw new ConflictError('Seat was modified concurrently, please retry');
        }
        await tx.seatHold.updateMany({
          where: { eventSeatId: { in: seats.map((s) => s.id) }, userId: booking.userId, status: 'ACTIVE' },
          data: { status: 'CONFIRMED' },
        });
        await tx.booking.update({ where: { id: booking.id }, data: { status: 'CONFIRMED', expiresAt: null } });
        await tx.payment.update({
          where: { bookingId: booking.id },
          data: { status: 'COMPLETED', provider: 'STRIPE', transactionRef: intent.id },
        });
        return 'confirmed' as const;
      }, { timeout: 15000 }) // headroom for the rare in-transaction refund call
    );
  } catch (err) {
    if (stripeEvent && isUniqueConstraintViolation(err, 'id')) return 'duplicate';
    throw err; // e.g. lock contention: the webhook returns 5xx and Stripe retries
  }

  const base = { bookingId: booking.id, userId: booking.userId, eventId: booking.eventId };
  const amount = Number(booking.totalAmount);
  if (outcome === 'confirmed') {
    await cacheInvalidate(cacheKeys.eventAvailability(booking.eventId), ...seatIds.map((id) => cacheKeys.seatStatus(booking.eventId, id)));
    await Promise.all([
      publishEvent(RoutingKey.BookingConfirmed, { ...base, seatIds, totalAmount: amount }),
      publishEvent(RoutingKey.PaymentCompleted, { ...base, amount, provider: 'STRIPE', paymentIntentId: intent.id }),
      publishEvent(RoutingKey.NotificationRequested, { userId: booking.userId, type: 'BOOKING_CONFIRMED', bookingId: booking.id }),
    ]);
  } else if (outcome === 'refunded') {
    await Promise.all([
      publishEvent(RoutingKey.PaymentFailed, { ...base, amount, reason: 'late_payment_refunded', paymentIntentId: intent.id }),
      publishEvent(RoutingKey.NotificationRequested, { userId: booking.userId, type: 'PAYMENT_REFUNDED', bookingId: booking.id }),
    ]);
  }
  logger.info({ operation: 'confirmPayment', bookingId: booking.id, paymentIntentId: intent.id, status: outcome }, `Stripe payment ${outcome}`);
  return outcome;
}

/**
 * Ends a PENDING checkout without payment (expired window, user cancel,
 * Stripe cancel): cancels the PaymentIntent, then returns the seats to
 * AVAILABLE. If Stripe reports the payment actually succeeded, it is
 * confirmed instead - the customer paid within the window.
 */
export async function abandonCheckout(bookingId: string, finalStatus: FinalStatus, reason: string): Promise<'released' | 'confirmed' | 'pending' | 'noop'> {
  const booking = await writeDB.booking.findUnique({ where: { id: bookingId }, include: { payment: true } });
  if (!booking || booking.status !== 'PENDING') return 'noop';

  const pastGrace = booking.expiresAt !== null && Date.now() > booking.expiresAt.getTime() + STRIPE_SETTLE_GRACE_MS;
  const intentId = booking.payment?.transactionRef;
  if (intentId) {
    try {
      const stripe = getStripe();
      let intent = await stripe.paymentIntents.retrieve(intentId);
      if (intent.status !== 'succeeded' && intent.status !== 'canceled' && intent.status !== 'processing') {
        intent = await stripe.paymentIntents.cancel(intentId).catch(() => stripe.paymentIntents.retrieve(intentId));
      }
      if (intent.status === 'succeeded') {
        const outcome = await confirmPaymentIntent(intent);
        return outcome === 'confirmed' || outcome === 'already_confirmed' ? 'confirmed' : 'noop';
      }
      if (intent.status !== 'canceled' && !pastGrace) return 'pending';
    } catch (err) {
      logger.warn({ operation: 'abandonCheckout', bookingId, status: 'stripe_error' }, (err as Error).message);
      // Unsure whether money moved: keep the seats until the grace runs out.
      if (!pastGrace && reason !== 'payment_init_failed') return 'pending';
    }
  }

  return (await releaseCheckout(bookingId, finalStatus, reason)) ? 'released' : 'noop';
}

/** PENDING -> finalStatus and the booking's HELD seats -> AVAILABLE, under the seat locks. */
async function releaseCheckout(bookingId: string, finalStatus: FinalStatus, reason: string): Promise<boolean> {
  const booking = await writeDB.booking.findUnique({ where: { id: bookingId }, include: { items: true } });
  if (!booking || booking.status !== 'PENDING') return false;
  const seatIds = booking.items.map((i) => i.seatId).sort();
  const eventSeatIds = booking.items.map((i) => i.eventSeatId);

  const released = await withNestedLocks(seatIds.map((s) => lockResource(booking.eventId, s)), () =>
    writeDB.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ status: string }[]>(Prisma.sql`
        SELECT status FROM bookings WHERE id = ${bookingId} FOR UPDATE
      `);
      if (locked.status !== 'PENDING') return false;
      await tx.$executeRaw(Prisma.sql`
        UPDATE event_seats SET status = 'AVAILABLE', held_by = NULL, hold_expires_at = NULL, version = version + 1
        WHERE id IN (${Prisma.join(eventSeatIds)}) AND status = 'HELD' AND held_by = ${booking.userId}
      `);
      await tx.seatHold.updateMany({
        where: { eventSeatId: { in: eventSeatIds }, userId: booking.userId, status: 'ACTIVE' },
        data: { status: finalStatus === 'CANCELLED' ? 'RELEASED' : 'EXPIRED' },
      });
      await tx.booking.update({ where: { id: bookingId }, data: { status: finalStatus } });
      await tx.payment.updateMany({ where: { bookingId, status: 'PENDING' }, data: { status: 'FAILED' } });
      return true;
    })
  );
  if (!released) return false;

  await cacheInvalidate(cacheKeys.eventAvailability(booking.eventId), ...seatIds.map((id) => cacheKeys.seatStatus(booking.eventId, id)));
  await Promise.all([
    ...seatIds.map((seatId) => publishEvent(RoutingKey.SeatReleased, { eventId: booking.eventId, seatId, userId: booking.userId, reason })),
    publishEvent(RoutingKey.PaymentFailed, {
      bookingId,
      userId: booking.userId,
      eventId: booking.eventId,
      amount: Number(booking.totalAmount),
      reason,
    }),
  ]);
  logger.info({ operation: 'releaseCheckout', bookingId, status: finalStatus }, `Checkout ${reason}, seats released`);
  return true;
}

/**
 * Local cron-style reconciliation (no webhook required): poll Stripe for
 * every PENDING checkout that already has a PaymentIntent and confirm or
 * fail from Stripe's own status. Runs on the worker every poll interval.
 */
export async function reconcilePendingPayments(): Promise<number> {
  const pending = await writeDB.booking.findMany({
    where: { status: 'PENDING', payment: { is: { transactionRef: { not: null } } } },
    include: { payment: true },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  let confirmed = 0;
  for (const booking of pending) {
    const intentId = booking.payment?.transactionRef;
    if (!intentId) continue;
    try {
      const intent = await getStripe().paymentIntents.retrieve(intentId);
      if (intent.status === 'succeeded') {
        const outcome = await confirmPaymentIntent(intent);
        if (outcome === 'confirmed' || outcome === 'already_confirmed') confirmed++;
      } else if (intent.status === 'canceled') {
        await abandonCheckout(booking.id, 'FAILED', 'payment_canceled');
      }
      // requires_payment_method / processing / requires_action: leave PENDING
      // until the user pays, payment/sync runs, or the window expires.
    } catch (err) {
      logger.error(
        { operation: 'reconcilePendingPayments', bookingId: booking.id, status: 'error' },
        (err as Error).message
      );
    }
  }
  if (confirmed > 0) {
    logger.info({ operation: 'reconcilePendingPayments', status: 'success' }, `Confirmed ${confirmed} booking(s) from Stripe poll`);
  }
  return confirmed;
}

/** Worker entry point: settles every PENDING checkout whose payment window has closed. */
export async function expirePendingCheckouts(): Promise<number> {
  const due = await writeDB.booking.findMany({
    where: { status: 'PENDING', expiresAt: { lt: new Date() } },
    select: { id: true },
    orderBy: { expiresAt: 'asc' },
    take: 50,
  });
  let released = 0;
  for (const { id } of due) {
    try {
      if ((await abandonCheckout(id, 'EXPIRED', 'payment_window_expired')) === 'released') released++;
    } catch (err) {
      logger.error({ operation: 'expirePendingCheckouts', bookingId: id, status: 'error' }, (err as Error).message);
    }
  }
  return released;
}

/**
 * Asks Stripe (server-to-server, secret key) for the PaymentIntent's real
 * state and confirms if it succeeded. Lets the UI settle right after
 * payment when the webhook is slow or not forwarded in local dev; it never
 * trusts anything the browser says about the payment.
 */
export async function syncPayment(bookingId: string, userId: string): Promise<{ id: string; status: string }> {
  const booking = await writeDB.booking.findUnique({ where: { id: bookingId }, include: { payment: true } });
  if (!booking) throw new NotFoundError('Booking');
  if (booking.userId !== userId) throw new ForbiddenError('You do not own this booking');
  if (booking.status === 'PENDING' && booking.payment?.transactionRef) {
    const intent = await getStripe().paymentIntents.retrieve(booking.payment.transactionRef);
    if (intent.status === 'succeeded') await confirmPaymentIntent(intent);
  }
  const fresh = await writeDB.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { status: true } });
  return { id: bookingId, status: fresh.status };
}
