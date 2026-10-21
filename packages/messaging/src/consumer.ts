import type { Channel, ConsumeMessage } from 'amqplib';
import { createChannel, getConnection, assertTopology, isClosedOnPurpose, EXCHANGE } from './connection';
import { DomainEvent, RoutingKeyValue } from './events';

const DLX = `${EXCHANGE}.dlx`;
const RESUBSCRIBE_DELAY_MS = 1000;

/**
 * Runs `subscribe` (open a channel, start consuming) and runs it again
 * whenever that channel closes, e.g. on a broker restart. Publishers recover
 * on their next publish, but a consumer never calls back in - without this
 * it stops for good while its process still looks healthy.
 */
export async function keepSubscribed(label: string, subscribe: () => Promise<Channel>): Promise<void> {
  const start = async (): Promise<void> => {
    const channel = await subscribe();
    channel.on('error', () => {}); // always followed by 'close', handled below
    channel.on('close', () => {
      if (isClosedOnPurpose()) return; // shutdown, not an outage
      log('warn', label, 'channel closed, resubscribing');
      retry();
    });
  };
  const retry = (): void => {
    setTimeout(() => {
      start()
        .then(() => log('info', label, 'resubscribed'))
        .catch((err) => {
          log('error', label, `resubscribe failed: ${(err as Error).message}`);
          retry();
        });
    }, RESUBSCRIBE_DELAY_MS);
  };
  await start();
}

function log(level: string, queue: string, message: string): void {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ level, component: 'messaging.consumer', queue, msg: message }));
}

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

  await keepSubscribed(queueName, async () => {
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
    return channel;
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
  await keepSubscribed('ephemeral', async () => {
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
    return channel;
  });
}
