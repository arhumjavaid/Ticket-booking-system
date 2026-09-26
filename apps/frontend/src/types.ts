export interface User {
  id: string;
  email: string;
  name: string;
  role: 'USER' | 'ADMIN';
}

export interface Venue {
  id: string;
  name: string;
  city: string;
  address: string;
}

export interface EventSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  startsAt: string;
  endsAt: string;
  basePrice: string;
  status: string;
  venue?: Venue;
}

export type SeatStatus = 'AVAILABLE' | 'HELD' | 'BOOKED' | 'BLOCKED';

export interface SeatView {
  eventSeatId: string;
  seatId: string;
  section: string;
  row: string;
  number: number;
  seatType: string;
  status: SeatStatus;
  price: string;
}

export interface BookingItem {
  id: string;
  seatId: string;
  price: string;
}

export interface Booking {
  id: string;
  status: string;
  eventId: string;
  totalAmount: string;
  createdAt: string;
  items: BookingItem[];
  event?: { id: string; name: string; startsAt: string };
}
