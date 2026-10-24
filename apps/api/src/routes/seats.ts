import { Router } from 'express';
import { readDB, Prisma } from '@ticketing/database';
import { cacheAside, cacheKeys } from '@ticketing/redis';
import { redisCacheHits, redisCacheMisses } from '@ticketing/metrics';
import { asyncHandler, CACHE_TTL_SECONDS } from '@ticketing/shared';
import { projectionServiceClient, searchServiceClient } from '../clients';
import { forwardServiceError } from '../proxyError';

export const router = Router();

router.get(
  '/:eventId/seats',
  asyncHandler(async (req, res) => {
    const { eventId } = req.params;
    const seats = await readDB.run((db) =>
      db.eventSeat.findMany({
        where: { eventId },
        include: { seat: { include: { section: true } } },
        orderBy: [{ seat: { section: { name: 'asc' } } }, { seat: { rowLabel: 'asc' } }, { seat: { seatNumber: 'asc' } }],
      })
    );

    res.status(200).json({
      success: true,
      data: seats.map((es) => ({
        eventSeatId: es.id,
        seatId: es.seatId,
        section: es.seat.section.name,
        row: es.seat.rowLabel,
        number: es.seat.seatNumber,
        seatType: es.seat.seatType,
        status: es.status,
        price: es.price,
      })),
    });
  })
);

router.get(
  '/:eventId/availability',
  asyncHandler(async (req, res) => {
    const { eventId } = req.params;
    const { value: summary, hit } = await cacheAside(
      cacheKeys.eventAvailability(eventId),
      CACHE_TTL_SECONDS.eventAvailability,
      async () => {
        // One grouped scan on a replica gives both totals and remaining seats
        // per ticket tier; cached until the next hold/booking/release on this
        // event invalidates it (or CACHE_TTL_SECONDS.eventAvailability lapses).
        const grouped = await readDB.run((db) =>
          db.$queryRaw<{ tier: string; status: string; count: number }[]>(Prisma.sql`
            SELECT UPPER(s.seat_type) AS tier, es.status::text AS status, COUNT(*)::int AS count
            FROM event_seats es JOIN seats s ON s.id = es.seat_id
            WHERE es.event_id = ${eventId}
            GROUP BY 1, 2
          `)
        );
        const empty = () => ({ AVAILABLE: 0, HELD: 0, BOOKED: 0, BLOCKED: 0 }) as Record<string, number>;
        const summary = empty();
        const byTier: Record<string, Record<string, number>> = {};
        for (const g of grouped) {
          summary[g.status] += g.count;
          (byTier[g.tier] ??= empty())[g.status] += g.count;
        }
        return { ...summary, byTier };
      }
    );
    (hit ? redisCacheHits : redisCacheMisses).inc({ cache: 'event_availability' });
    res.status(200).json({ success: true, data: summary });
  })
);

// ---- Eventually consistent read models (never on the booking path) ----

/** Proxies a read-model GET; these stores lag Postgres by design. */
function readModel(client: typeof searchServiceClient, path: (eventId: string) => string, unavailable: string) {
  return asyncHandler(async (req, res) => {
    try {
      const response = await client.get(path(req.params.eventId));
      res.status(200).json(response.data);
    } catch (err) {
      forwardServiceError(err, res, unavailable);
    }
  });
}

// MongoDB: live seat-map heat / activity document.
router.get('/:eventId/live', readModel(projectionServiceClient, (id) => `/projections/events/${id}`, 'Live activity is temporarily unavailable'));
// Neo4j: "people who booked this also booked".
router.get('/:eventId/also-booked', readModel(projectionServiceClient, (id) => `/graph/events/${id}/also-booked`, 'Recommendations are temporarily unavailable'));
// OpenSearch k-NN: similar events by embedding.
router.get('/:eventId/similar', readModel(searchServiceClient, (id) => `/search/events/${id}/similar`, 'Similar events are temporarily unavailable'));
