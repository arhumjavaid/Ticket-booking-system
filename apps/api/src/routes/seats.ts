import { Router } from 'express';
import { readDB } from '@ticketing/database';
import { cacheAside, cacheKeys } from '@ticketing/redis';
import { redisCacheHits, redisCacheMisses } from '@ticketing/metrics';
import { asyncHandler, CACHE_TTL_SECONDS } from '@ticketing/shared';

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
        const grouped = await readDB.run((db) =>
          db.eventSeat.groupBy({ by: ['status'], where: { eventId }, _count: { status: true } })
        );
        const summary = { AVAILABLE: 0, HELD: 0, BOOKED: 0, BLOCKED: 0 } as Record<string, number>;
        for (const g of grouped) summary[g.status] = g._count.status;
        return summary;
      }
    );
    (hit ? redisCacheHits : redisCacheMisses).inc({ cache: 'event_availability' });
    res.status(200).json({ success: true, data: summary });
  })
);
