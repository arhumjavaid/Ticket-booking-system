export const RoutingKey = {
  BookingCreated: 'booking.created',
  BookingConfirmed: 'booking.confirmed',
  BookingCancelled: 'booking.cancelled',
  SeatHeld: 'seat.held',
  SeatReleased: 'seat.released',
  PaymentCompleted: 'payment.completed',
  NotificationRequested: 'notification.requested',
  EventCreated: 'event.created',
} as const;

export type RoutingKeyValue = (typeof RoutingKey)[keyof typeof RoutingKey];

export interface DomainEvent<T = Record<string, unknown>> {
  eventId: string;
  routingKey: RoutingKeyValue;
  occurredAt: string;
  requestId?: string;
  data: T;
}
