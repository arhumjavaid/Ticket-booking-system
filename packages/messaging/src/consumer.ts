import type { ConsumeMessage } from 'amqplib';
import { createChannel, getConnection, assertTopology, EXCHANGE } from './connection';
import { DomainEvent, RoutingKeyValue } from './events';

const DLX = `${EXCHANGE}.dlx`;

export interface ConsumeOptions {
  prefetch?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

export type EventHandler<T = Record<string, unknown>> = (event: DomainEvent<T>) => Promise<void>;

/**
 * Subscribes `queueName` to one or more routing-key patterns on the shared
 * topic exchange and processes messages with automatic retry + a dead
 * letter queue.
 *
 * Retries (RULE 10): on handler failure the message is republished to the
 * same queue with an incremented `x-retry-count` header after a backoff
 * delay, up to `maxRetries`. Once exhausted, the message is routed to
 * `${queueName}.dlq` for manual inspection instead of being lost or
 * looping forever.
 *
 * Idempotency (RULE 11): handlers are expected to be idempotent (e.g. by
 * checking `event.eventId` against a processed-events table/set) since
 * retries and consumer restarts can both cause redelivery.
 */
export async function consume<T = Record<string, unknown>>(
  queueName: string,
  patterns: RoutingKeyValue[],
  handler: EventHandler<T>,
  options: ConsumeOptions = {}
): Promise<void> {
  const prefetch = options.prefetch ?? 10;
  const maxRetries = options.maxRetries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 2000;

  const channel = await createChannel();
  await channel.assertExchange(DLX, 'topic', { durable: true });

  const dlqName = `${queueName}.dlq`;
  await channel.assertQueue(dlqName, { durable: true });
  await channel.bindQueue(dlqName, DLX, '#');

  await channel.assertQueue(queueName, { durable: true });
  for (const pattern of patterns) {
    await channel.bindQueue(queueName, EXCHANGE, pattern);
  }

  await channel.prefetch(prefetch);

  channel.consume(queueName, async (msg: ConsumeMessage | null) => {
    if (!msg) return;

    const retryCount = (msg.properties.headers?.['x-retry-count'] as number) ?? 0;
    let event: DomainEvent<T>;
    try {
      event = JSON.parse(msg.content.toString());
    } catch (err) {
      // Unparseable message: dead-letter immediately, retrying won't help.
      channel.publish(DLX, msg.fields.routingKey, msg.content, msg.properties);
      channel.ack(msg);
      return;
    }

    try {
      await handler(event);
      channel.ack(msg);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify({
          level: 'error',
          component: 'messaging.consumer',
          queue: queueName,
          routingKey: msg.fields.routingKey,
          eventId: event.eventId,
          retryCount,
          error: (err as Error).message,
        })
      );

      channel.ack(msg); // remove from the live queue either way

      if (retryCount < maxRetries) {
        setTimeout(() => {
          channel.publish(EXCHANGE, msg.fields.routingKey, msg.content, {
            ...msg.properties,
            headers: { ...msg.properties.headers, 'x-retry-count': retryCount + 1 },
          });
        }, retryDelayMs * (retryCount + 1));
      } else {
        channel.publish(DLX, msg.fields.routingKey, msg.content, msg.properties);
      }
    }
  });
}

/**
 * Subscribes to routing-key patterns via a private, auto-delete queue that
 * is deleted the moment this process disconnects. Used for non-critical,
 * best-effort fan-out (e.g. pushing seat-availability changes to browsers
 * over SSE) where losing a message on a restart is acceptable - unlike
 * `consume()`, there is no retry or dead-letter handling here, by design.
 */
export async function consumeEphemeral<T = Record<string, unknown>>(
  patterns: RoutingKeyValue[],
  handler: EventHandler<T>
): Promise<void> {
  const conn = await getConnection();
  const channel = await conn.createChannel();
  await assertTopology(channel);
  const { queue } = await channel.assertQueue('', { exclusive: true, autoDelete: true });
  for (const pattern of patterns) {
    await channel.bindQueue(queue, EXCHANGE, pattern);
  }
  channel.consume(queue, async (msg) => {
    if (!msg) return;
    try {
      const event = JSON.parse(msg.content.toString());
      await handler(event);
    } catch {
      // best-effort only - swallow and move on
    } finally {
      channel.ack(msg);
    }
  });
}
