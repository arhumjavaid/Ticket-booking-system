import { EventEmitter } from 'events';
import type { Request, Response } from 'express';
import { consumeEphemeral, RoutingKey } from '@ticketing/messaging';
import { logger } from '@ticketing/logging';

// In-memory fan-out scoped to THIS instance's own SSE connections only.
// This is connection-multiplexing state, not booking/business state, so it
// does not violate "API servers must remain stateless" (section 13/RULE 6):
// if this instance restarts, connected browsers simply reconnect - possibly
// to a different instance via Nginx - and lose nothing, because Postgres
// (not this emitter) is the source of truth for seat status.
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let started = false;

export async function startRealtimeBridge(): Promise<void> {
  if (started) return;
  started = true;
  await consumeEphemeral(
    [RoutingKey.SeatHeld, RoutingKey.SeatReleased, RoutingKey.BookingConfirmed, RoutingKey.BookingCancelled],
    async (event) => {
      const eventId = (event.data as { eventId?: string }).eventId;
      if (eventId) emitter.emit(eventId, event);
    }
  );
  logger.info({ operation: 'realtime_bridge', status: 'started' }, 'Realtime SSE bridge subscribed to booking.events');
}

export function eventAvailabilityStream(req: Request, res: Response): void {
  const { eventId } = req.params;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ eventId })}\n\n`);

  const listener = (event: unknown) => {
    res.write(`event: seat-update\ndata: ${JSON.stringify(event)}\n\n`);
  };
  emitter.on(eventId, listener);

  const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    emitter.off(eventId, listener);
  });
}
