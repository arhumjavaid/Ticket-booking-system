import { readDB } from '@ticketing/database';
import type { DomainEvent } from '@ticketing/messaging';
import { logger } from '@ticketing/logging';
import { opensearch, INDEX_NAME, VECTOR_INDEX_NAME } from './client';
import { embed } from './embedding';

/**
 * The search index is eventually consistent by design (RULE 8 / section
 * 20): PostgreSQL remains the source of truth for the event itself, and
 * this handler re-derives the OpenSearch document from Postgres rather
 * than trusting the (possibly stale, possibly redelivered) event payload
 * directly - which also makes it naturally idempotent (RULE 11).
 */
export async function handleEventCreated(event: DomainEvent<{ eventId: string }>): Promise<void> {
  await indexEvent(event.data.eventId);
}

/**
 * Indexes every event already in Postgres. Run at startup because events
 * written without an event.created message (seed data, or ones created
 * while RabbitMQ was down) would otherwise never become searchable.
 * ponytail: one request per event; switch to the _bulk API if the catalogue
 * grows past a few thousand events.
 */
export async function reindexAll(): Promise<number> {
  const events = await readDB.run((db) => db.event.findMany({ select: { id: true } }));
  for (const { id } of events) {
    await indexEvent(id);
  }
  return events.length;
}

async function indexEvent(eventId: string): Promise<void> {
  const record = await readDB.run((db) => db.event.findUnique({ where: { id: eventId }, include: { venue: true } }));
  if (!record) return;

  const availableSeats = await readDB.run((db) => db.eventSeat.count({ where: { eventId, status: 'AVAILABLE' } }));

  const body = {
    eventId: record.id,
    name: record.name,
    description: record.description,
    category: record.category,
    venueName: record.venue.name,
    city: record.venue.city,
    tags: record.tags,
    startsAt: record.startsAt,
    basePrice: Number(record.basePrice),
    status: record.status,
    availableSeats,
  };
  await opensearch.index({ index: INDEX_NAME, id: eventId, body, refresh: true });
  await opensearch.index({ index: VECTOR_INDEX_NAME, id: eventId, body: { ...body, embedding: embed(record) }, refresh: true });

  logger.info({ operation: 'search_index', status: 'indexed', eventId }, `Indexed event ${eventId} into OpenSearch`);
}

/** Best-effort availability refresh triggered by seat/booking activity. */
export async function refreshAvailability(event: DomainEvent<{ eventId?: string }>): Promise<void> {
  const eventId = event.data.eventId;
  if (!eventId) return;

  try {
    const availableSeats = await readDB.run((db) => db.eventSeat.count({ where: { eventId, status: 'AVAILABLE' } }));
    await opensearch.update({
      index: INDEX_NAME,
      id: eventId,
      body: { doc: { availableSeats } },
    });
  } catch (err) {
    // The document may not exist yet if indexing raced with this update -
    // non-critical, the next event.created / startup reindex will fix it.
    logger.warn({ operation: 'search_index', status: 'refresh_skipped', eventId }, (err as Error).message);
  }
}
