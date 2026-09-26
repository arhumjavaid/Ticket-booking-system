import { writeDB } from '@ticketing/database';
import type { DomainEvent } from '@ticketing/messaging';
import { logger } from '@ticketing/logging';
import { queueMessagesTotal } from '@ticketing/metrics';

interface NotificationRequestedPayload {
  userId: string;
  type: string;
  bookingId?: string;
}

/**
 * Simulates sending a notification (email/SMS/push) by persisting it and
 * logging what would have been sent. RULE 9/11: this handler is idempotent
 * - redelivery of the same event (retry, consumer restart) must not create
 * a second notification for the same booking+type.
 */
export async function handleNotificationRequested(event: DomainEvent<NotificationRequestedPayload>): Promise<void> {
  const { userId, type, bookingId } = event.data;

  const existing = bookingId
    ? await writeDB.notification.findFirst({
        where: { userId, type, payload: { path: ['bookingId'], equals: bookingId } },
      })
    : null;

  if (existing) {
    logger.info({ operation: 'notification', status: 'duplicate_skipped', bookingId }, `Notification already sent for ${type}/${bookingId}`);
    return;
  }

  const notification = await writeDB.notification.create({
    data: {
      userId,
      type,
      channel: 'EMAIL',
      payload: { bookingId, eventId: event.eventId, occurredAt: event.occurredAt },
      status: 'SENT',
    },
  });

  queueMessagesTotal.inc({ queue: 'notification-service', direction: 'consumed' });
  logger.info(
    { operation: 'notification', status: 'sent', bookingId },
    `[SIMULATED EMAIL] To user ${userId}: ${type} (notification ${notification.id})`
  );
}
