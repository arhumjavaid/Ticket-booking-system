import { clickhouse } from './clickhouse';

async function queryRows<T>(query: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const result = await clickhouse.query({ query, query_params: params, format: 'JSONEachRow' });
  return result.json<T>();
}

export interface EventAnalytics {
  ticket_event_id: string;
  bookings_confirmed: number;
  bookings_cancelled: number;
  seats_sold: number;
  holds_total: number;
  revenue: number;
  cancellation_rate: number;
}

export async function getEventAnalytics(eventId: string): Promise<EventAnalytics> {
  const rows = await queryRows<{
    bookings_confirmed: string;
    bookings_cancelled: string;
    seats_sold: string;
    holds_total: string;
    revenue: string;
  }>(
    `
    SELECT
      countIf(routing_key = 'booking.confirmed') AS bookings_confirmed,
      countIf(routing_key = 'booking.cancelled') AS bookings_cancelled,
      sumIf(seat_count, routing_key = 'booking.confirmed') AS seats_sold,
      countIf(routing_key = 'seat.held') AS holds_total,
      sumIf(amount, routing_key = 'payment.completed') AS revenue
    FROM booking_events FINAL
    WHERE ticket_event_id = {eventId:String}
    `,
    { eventId }
  );

  const r = rows[0] || { bookings_confirmed: '0', bookings_cancelled: '0', seats_sold: '0', holds_total: '0', revenue: '0' };
  const confirmed = Number(r.bookings_confirmed);
  const cancelled = Number(r.bookings_cancelled);

  return {
    ticket_event_id: eventId,
    bookings_confirmed: confirmed,
    bookings_cancelled: cancelled,
    seats_sold: Number(r.seats_sold),
    holds_total: Number(r.holds_total),
    revenue: Number(r.revenue),
    cancellation_rate: confirmed + cancelled > 0 ? cancelled / (confirmed + cancelled) : 0,
  };
}

export interface DashboardAnalytics {
  totalBookings: number;
  totalCancellations: number;
  totalRevenue: number;
  uniqueUsers: number;
  peakBookingHour: number | null;
  topEvents: { ticketEventId: string; bookings: number }[];
}

export async function getDashboardAnalytics(): Promise<DashboardAnalytics> {
  const [summary] = await queryRows<{
    total_bookings: string;
    total_cancellations: string;
    total_revenue: string;
    unique_users: string;
  }>(`
    SELECT
      countIf(routing_key = 'booking.confirmed') AS total_bookings,
      countIf(routing_key = 'booking.cancelled') AS total_cancellations,
      sumIf(amount, routing_key = 'payment.completed') AS total_revenue,
      uniqExact(user_id) AS unique_users
    FROM booking_events FINAL
  `);

  const peakRows = await queryRows<{ hour: string; bookings: string }>(`
    SELECT toHour(occurred_at) AS hour, count() AS bookings
    FROM booking_events FINAL
    WHERE routing_key = 'booking.confirmed'
    GROUP BY hour
    ORDER BY bookings DESC
    LIMIT 1
  `);

  const topEventRows = await queryRows<{ ticket_event_id: string; bookings: string }>(`
    SELECT ticket_event_id, count() AS bookings
    FROM booking_events FINAL
    WHERE routing_key = 'booking.confirmed' AND ticket_event_id != ''
    GROUP BY ticket_event_id
    ORDER BY bookings DESC
    LIMIT 10
  `);

  return {
    totalBookings: Number(summary?.total_bookings || 0),
    totalCancellations: Number(summary?.total_cancellations || 0),
    totalRevenue: Number(summary?.total_revenue || 0),
    uniqueUsers: Number(summary?.unique_users || 0),
    peakBookingHour: peakRows[0] ? Number(peakRows[0].hour) : null,
    topEvents: topEventRows.map((r) => ({ ticketEventId: r.ticket_event_id, bookings: Number(r.bookings) })),
  };
}
