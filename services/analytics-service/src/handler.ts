import type { DomainEvent, RoutingKeyValue } from '@ticketing/messaging';
import { clickhouse } from './clickhouse';

interface EventRow {
  event_id: string;
  routing_key: RoutingKeyValue;
  occurred_at: string;
  ticket_event_id: string;
  booking_id: string;
  user_id: string;
  seat_id: string;
  seat_count: number;
  amount: number;
}

function extractRow(event: DomainEvent<Record<string, unknown>>): EventRow {
  const data = event.data as Record<string, unknown>;
  const seatIds = Array.isArray(data.seatIds) ? (data.seatIds as string[]) : [];

  return {
    event_id: event.eventId,
    routing_key: event.routingKey,
    occurred_at: event.occurredAt.replace('T', ' ').replace('Z', ''),
    ticket_event_id: (data.eventId as string) || '',
    booking_id: (data.bookingId as string) || '',
    user_id: (data.userId as string) || '',
    seat_id: (data.seatId as string) || '',
    seat_count: seatIds.length,
    amount: typeof data.amount === 'number' ? data.amount : typeof data.totalAmount === 'number' ? data.totalAmount : 0,
  };
}

export async function handleAnalyticsEvent(event: DomainEvent<Record<string, unknown>>): Promise<void> {
  const row = extractRow(event);
  await clickhouse.insert({
    table: 'booking_events',
    values: [row],
    format: 'JSONEachRow',
  });
}
