import '../setupIntegrationEnv';
import { publishEvent, consumeEphemeral, RoutingKey, closeConnection } from '@ticketing/messaging';

describe('RabbitMQ topic exchange (real broker)', () => {
  afterAll(async () => {
    await closeConnection();
  });

  it('delivers a published event to a subscriber bound by routing-key pattern', async () => {
    const received: unknown[] = [];
    await consumeEphemeral([RoutingKey.SeatHeld], async (event) => {
      received.push(event);
    });

    // give the consumer's queue binding a moment to register with the broker
    await new Promise((r) => setTimeout(r, 300));

    const eventId = `it-event-${Date.now()}`;
    await publishEvent(RoutingKey.SeatHeld, { eventId, seatId: 'seat-1', userId: 'user-1' });

    await new Promise((r) => setTimeout(r, 500));

    expect(received).toHaveLength(1);
    expect((received[0] as any).data.eventId).toBe(eventId);
  });

  it('does not deliver events that do not match the bound routing-key pattern', async () => {
    const received: unknown[] = [];
    await consumeEphemeral([RoutingKey.BookingCancelled], async (event) => {
      received.push(event);
    });

    await new Promise((r) => setTimeout(r, 300));
    await publishEvent(RoutingKey.SeatReleased, { eventId: 'x', seatId: 'y' });
    await new Promise((r) => setTimeout(r, 500));

    expect(received).toHaveLength(0);
  });
});
