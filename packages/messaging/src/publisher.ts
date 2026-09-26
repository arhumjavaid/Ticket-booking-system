import { v4 as uuidv4 } from 'uuid';
import type { Channel } from 'amqplib';
import { createChannel, EXCHANGE } from './connection';
import { DomainEvent, RoutingKeyValue } from './events';

let publishChannel: Channel | null = null;

async function getPublishChannel(): Promise<Channel> {
  if (publishChannel) return publishChannel;
  publishChannel = await createChannel();
  publishChannel.on('close', () => {
    publishChannel = null;
  });
  return publishChannel;
}

const PUBLISH_TIMEOUT_MS = 1500;

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`publish timed out after ${ms}ms`)), ms));
}

/**
 * Publishes a domain event to the `booking.events` topic exchange.
 *
 * IMPORTANT (RULE 7/8/9): this is called AFTER the PostgreSQL transaction
 * has already committed. A publish failure here must never be allowed to
 * fail the booking response - we log and swallow, because the booking is
 * already durable in Postgres.
 *
 * Bounded by a short timeout: `connection.ts`'s `getConnection()` retries
 * forever while RabbitMQ is down (by design, so it self-heals once the
 * broker returns), which means an *unbounded* await here would hang the
 * HTTP response for as long as the outage lasts - turning a non-critical
 * dependency into a critical one by accident. Racing against a timeout
 * keeps this call fast regardless of broker state, at the cost of that one
 * event being dropped rather than delivered late (an accepted tradeoff
 * without a transactional outbox - see docs/DISTRIBUTED_SYSTEMS.md).
 */
export async function publishEvent<T extends Record<string, unknown>>(
  routingKey: RoutingKeyValue,
  data: T,
  requestId?: string
): Promise<void> {
  const event: DomainEvent<T> = {
    eventId: uuidv4(),
    routingKey,
    occurredAt: new Date().toISOString(),
    requestId,
    data,
  };

  try {
    await Promise.race([
      (async () => {
        const channel = await getPublishChannel();
        channel.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(event)), {
          persistent: true,
          contentType: 'application/json',
          messageId: event.eventId,
          headers: { 'x-retry-count': 0 },
        });
      })(),
      timeout(PUBLISH_TIMEOUT_MS),
    ]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        level: 'error',
        component: 'messaging.publisher',
        message: 'failed to publish event, booking state is unaffected',
        routingKey,
        error: (err as Error).message,
      })
    );
  }
}
