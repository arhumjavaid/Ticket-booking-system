import { MongoClient } from 'mongodb';
import type { DomainEvent } from '@ticketing/messaging';

/**
 * MongoDB holds the high-churn, eventually consistent "live activity"
 * document per event: per-seat demand heat (how often each seat gets held)
 * plus running counters. Every write is a commutative $inc/$max, so
 * out-of-order delivery converges; duplicates are dropped by event id.
 * Seat STATUS is deliberately not kept here - Postgres owns that.
 */
const mongo = new MongoClient(process.env.MONGO_URL || 'mongodb://localhost:27017', { serverSelectionTimeoutMS: 5000 });
const db = mongo.db(process.env.MONGO_DATABASE || 'ticketing_live');
const live = db.collection<LiveDoc>('event_live');
const processed = db.collection<{ _id: string; at: Date }>('processed_events');

export interface LiveDoc {
  _id: string; // ticket event id
  heat: Record<string, number>; // seatId -> times held
  counters: Record<string, number>;
  lastActivityAt: Date;
}

type Data = { eventId?: string; seatId?: string; seatIds?: string[]; amount?: number };

export async function connectLive(): Promise<void> {
  await mongo.connect();
  // Dedupe markers only need to outlive the broker's retry window.
  await processed.createIndex({ at: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
}

export function liveUpdate(event: DomainEvent<Data>): Record<string, number> | null {
  const { seatId, seatIds = [], amount = 0 } = event.data;
  switch (event.routingKey) {
    case 'seat.held':
      return seatId ? { [`heat.${seatId}`]: 1, 'counters.holds': 1 } : null;
    case 'seat.released':
      return { 'counters.releases': 1 };
    case 'booking.confirmed':
      return { 'counters.bookings': 1, 'counters.seatsSold': seatIds.length };
    case 'booking.cancelled':
      return { 'counters.cancellations': 1 };
    case 'payment.completed':
      return { 'counters.revenue': amount };
    case 'payment.failed':
      return { 'counters.failedPayments': 1 };
    default:
      return null;
  }
}

export async function handleLiveEvent(event: DomainEvent<Data>): Promise<void> {
  const inc = liveUpdate(event);
  if (!event.data.eventId || !inc) return;

  try {
    await processed.insertOne({ _id: event.eventId, at: new Date() });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return; // redelivery, already applied
    throw err;
  }
  try {
    await live.updateOne(
      { _id: event.data.eventId },
      { $inc: inc, $max: { lastActivityAt: new Date(event.occurredAt) } },
      { upsert: true }
    );
  } catch (err) {
    await processed.deleteOne({ _id: event.eventId }); // let the retry apply it
    throw err;
  }
}

export async function getLive(eventId: string) {
  const doc = await live.findOne({ _id: eventId });
  const heat = Object.entries(doc?.heat ?? {})
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20)
    .map(([seatId, holds]) => ({ seatId, holds }));
  return { eventId, counters: doc?.counters ?? {}, hottestSeats: heat, lastActivityAt: doc?.lastActivityAt ?? null };
}

export async function pingMongo(): Promise<boolean> {
  return db.command({ ping: 1 }).then(() => true, () => false);
}
