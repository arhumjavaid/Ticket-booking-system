import neo4j from 'neo4j-driver';
import { readDB } from '@ticketing/database';
import type { DomainEvent } from '@ticketing/messaging';

/**
 * Neo4j relationship graph: (User)-[:BOOKED {bookingId}]->(Event)-[:AT]->(Venue).
 * Fed asynchronously from booking events, never on the booking path.
 * Everything is MERGE-based, so redelivery is harmless, and a cancel is a
 * flag on the same MERGEd relationship - it converges whichever of
 * confirmed/cancelled arrives first.
 */
const driver = neo4j.driver(
  process.env.NEO4J_URL || 'bolt://localhost:7687',
  neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD || 'ticketing-graph')
);

async function run(query: string, params: Record<string, unknown> = {}) {
  const session = driver.session();
  try {
    return (await session.run(query, params)).records;
  } finally {
    await session.close();
  }
}

export async function connectGraph(): Promise<void> {
  await driver.verifyConnectivity();
  for (const label of ['User', 'Event', 'Venue']) {
    await run(`CREATE CONSTRAINT ${label.toLowerCase()}_id IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`);
  }
}

/** Event + venue properties come from Postgres (replica), not the message payload. */
async function upsertEvent(eventId: string): Promise<void> {
  const event = await readDB.run((db) => db.event.findUnique({ where: { id: eventId }, include: { venue: true } }));
  if (!event) return;
  await run(
    `MERGE (e:Event {id: $id}) SET e.name = $name, e.category = $category, e.startsAt = $startsAt
     MERGE (v:Venue {id: $venueId}) SET v.name = $venueName, v.city = $city
     MERGE (e)-[:AT]->(v)`,
    {
      id: event.id,
      name: event.name,
      category: event.category,
      startsAt: event.startsAt.toISOString(),
      venueId: event.venueId,
      venueName: event.venue.name,
      city: event.venue.city,
    }
  );
}

type Data = { eventId?: string; userId?: string; bookingId?: string; seatIds?: string[] };

export async function handleGraphEvent(event: DomainEvent<Data>): Promise<void> {
  const { eventId, userId, bookingId, seatIds = [] } = event.data;
  if (!eventId) return;
  if (event.routingKey === 'event.created') return upsertEvent(eventId);
  if (!userId || !bookingId) return;

  if (event.routingKey === 'booking.confirmed') await upsertEvent(eventId);
  const cancelled = event.routingKey === 'booking.cancelled';
  await run(
    `MERGE (u:User {id: $userId})
     MERGE (e:Event {id: $eventId})
     MERGE (u)-[b:BOOKED {bookingId: $bookingId}]->(e)
     ${cancelled ? 'SET b.cancelled = true' : 'SET b.seats = $seats, b.at = $at'}`,
    { userId, eventId, bookingId, seats: seatIds.length, at: event.occurredAt }
  );
}

const ACTIVE = (rel: string) => `coalesce(${rel}.cancelled, false) = false`;

/** "People who booked this also booked" - two hops through shared buyers. */
export async function alsoBooked(eventId: string, limit = 5) {
  const records = await run(
    `MATCH (e:Event {id: $eventId})<-[b1:BOOKED]-(u:User)-[b2:BOOKED]->(o:Event)
     WHERE o <> e AND ${ACTIVE('b1')} AND ${ACTIVE('b2')}
     RETURN o.id AS eventId, o.name AS name, o.category AS category, count(DISTINCT u) AS sharedBuyers
     ORDER BY sharedBuyers DESC LIMIT $limit`,
    { eventId, limit: neo4j.int(limit) }
  );
  return records.map((r) => ({
    eventId: r.get('eventId'),
    name: r.get('name'),
    category: r.get('category'),
    sharedBuyers: r.get('sharedBuyers').toNumber(),
  }));
}

/** Nodes + links around one event, ready for a force-directed admin view. */
export async function eventGraph(eventId: string) {
  const records = await run(
    `MATCH (e:Event {id: $eventId})
     OPTIONAL MATCH (e)-[:AT]->(v:Venue)
     OPTIONAL MATCH (u:User)-[b:BOOKED]->(e) WHERE ${ACTIVE('b')}
     OPTIONAL MATCH (u)-[b2:BOOKED]->(o:Event) WHERE o <> e AND ${ACTIVE('b2')}
     RETURN e.name AS eventName, v.id AS venueId, v.name AS venueName, u.id AS userId, o.id AS otherId, o.name AS otherName
     LIMIT 500`,
    { eventId }
  );
  const nodes = new Map<string, { id: string; type: string; label: string }>();
  const links = new Set<string>();
  const link = (source: string, target: string, type: string) => links.add(JSON.stringify({ source, target, type }));
  for (const r of records) {
    nodes.set(eventId, { id: eventId, type: 'Event', label: r.get('eventName') });
    if (r.get('venueId')) {
      nodes.set(r.get('venueId'), { id: r.get('venueId'), type: 'Venue', label: r.get('venueName') });
      link(eventId, r.get('venueId'), 'AT');
    }
    if (r.get('userId')) {
      nodes.set(r.get('userId'), { id: r.get('userId'), type: 'User', label: `user ${String(r.get('userId')).slice(0, 8)}` });
      link(r.get('userId'), eventId, 'BOOKED');
    }
    if (r.get('otherId')) {
      nodes.set(r.get('otherId'), { id: r.get('otherId'), type: 'Event', label: r.get('otherName') });
      link(r.get('userId'), r.get('otherId'), 'BOOKED');
    }
  }
  return { nodes: [...nodes.values()], links: [...links].map((l) => JSON.parse(l)) };
}

export async function pingGraph(): Promise<boolean> {
  return driver.verifyConnectivity().then(() => true, () => false);
}
