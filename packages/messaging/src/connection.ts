import * as amqp from 'amqplib';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';
export const EXCHANGE = process.env.RABBITMQ_EXCHANGE || 'booking.events';

let connection: amqp.ChannelModel | null = null;
let connecting: Promise<amqp.ChannelModel> | null = null;

/**
 * Lazily connects to RabbitMQ with retry/backoff, and transparently
 * reconnects on connection loss. Every publisher/consumer in the system
 * calls getConnection() rather than holding their own long-lived handle, so
 * a broker restart during local failure testing (`docker stop rabbitmq`)
 * self-heals once the container comes back.
 */
export async function getConnection(): Promise<amqp.ChannelModel> {
  if (connection) return connection;
  if (connecting) return connecting;

  connecting = (async () => {
    let attempt = 0;
    // Keep retrying rather than crashing the process - the message queue
    // being temporarily unavailable must not take down the API/worker.
    while (true) {
      try {
        const conn = await amqp.connect(RABBITMQ_URL);
        conn.on('close', () => {
          connection = null;
        });
        conn.on('error', () => {
          connection = null;
        });
        connection = conn;
        connecting = null;
        return conn;
      } catch (err) {
        attempt += 1;
        const delay = Math.min(500 * attempt, 5000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  })();

  return connecting;
}

export async function assertTopology(channel: amqp.Channel): Promise<void> {
  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
}

export async function createChannel(): Promise<amqp.Channel> {
  const conn = await getConnection();
  const channel = await conn.createChannel();
  await assertTopology(channel);
  return channel;
}

export async function closeConnection(): Promise<void> {
  if (connection) {
    await connection.close();
    connection = null;
  }
}
