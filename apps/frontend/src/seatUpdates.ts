import type { SeatStatus, SeatView } from './types';

export interface SeatUpdateEvent {
  routingKey: string;
  data: { seatId?: string; seatIds?: string[] };
}

// booking.cancelled is absent on purpose: cancelService also publishes a
// seat.released per seat, which is what frees them here.
const STATUS_BY_ROUTING_KEY: Record<string, SeatStatus> = {
  'seat.held': 'HELD',
  'seat.released': 'AVAILABLE',
  'booking.confirmed': 'BOOKED',
};

/** Seat IDs an SSE update changes, and the status they change to. */
export function seatChange(event: SeatUpdateEvent): { status: SeatStatus; seatIds: string[] } | null {
  const status = STATUS_BY_ROUTING_KEY[event.routingKey];
  if (!status) return null;
  const seatIds = event.data.seatIds ?? (event.data.seatId ? [event.data.seatId] : []);
  return seatIds.length > 0 ? { status, seatIds } : null;
}

/**
 * Applies a change in place of re-fetching the whole seat map, which would
 * cost every viewer a full read per update and could return a lagging
 * replica's older state. Returns the same array when nothing changed.
 */
export function applySeatStatus(seats: SeatView[], seatIds: string[], status: SeatStatus): SeatView[] {
  const ids = new Set(seatIds);
  if (!seats.some((s) => ids.has(s.seatId) && s.status !== status)) return seats;
  return seats.map((s) => (ids.has(s.seatId) ? { ...s, status } : s));
}
