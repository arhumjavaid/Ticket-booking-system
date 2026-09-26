export interface EventSeatRow {
  id: string;
  event_id: string;
  seat_id: string;
  status: 'AVAILABLE' | 'HELD' | 'BOOKED' | 'BLOCKED';
  price: string;
  version: number;
  held_by: string | null;
  hold_expires_at: Date | null;
  updated_at: Date;
}

export interface HoldSeatRequest {
  eventId: string;
  seatId: string;
  userId: string;
}

export interface CreateBookingRequest {
  userId: string;
  eventId: string;
  seatIds: string[];
  idempotencyKey?: string;
}

export interface CancelBookingRequest {
  bookingId: string;
  userId: string;
  isAdmin?: boolean;
}
