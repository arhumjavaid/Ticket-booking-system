import { Router } from 'express';
import { z } from 'zod';
import { writeDB, readDB, recordAuditLog } from '@ticketing/database';
import { authenticate, authorize, optionalAuthenticate } from '@ticketing/auth';
import { eventBloomFilter, eventSeatBloomFilter, cacheAside, cacheInvalidate, cacheKeys } from '@ticketing/redis';
import { publishEvent, RoutingKey } from '@ticketing/messaging';
import { redisCacheHits, redisCacheMisses } from '@ticketing/metrics';
import { asyncHandler, validateBody, NotFoundError, CACHE_TTL_SECONDS, RATE_LIMITS } from '@ticketing/shared';
import { rateLimitMiddleware } from '../middleware/rateLimitMiddleware';

export const router = Router();

router.get(
  '/',
  optionalAuthenticate,
  rateLimitMiddleware('browse', RATE_LIMITS.browse.limit, RATE_LIMITS.browse.windowSeconds),
  asyncHandler(async (req, res) => {
    const page = Math.max(parseInt(String(req.query.page || '1'), 10), 1);
    const pageSize = Math.min(Math.max(parseInt(String(req.query.pageSize || '20'), 10), 1), 100);
    const category = req.query.category ? String(req.query.category) : undefined;

    const [events, total] = await readDB.run((db) =>
      Promise.all([
        db.event.findMany({
          where: { status: 'PUBLISHED', ...(category ? { category } : {}) },
          include: { venue: true },
          orderBy: { startsAt: 'asc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        db.event.count({ where: { status: 'PUBLISHED', ...(category ? { category } : {}) } }),
      ])
    );

    res.status(200).json({ success: true, data: events, pagination: { page, pageSize, total } });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    // Bloom filter: definite negative short-circuits straight to a 404
    // instead of round-tripping to a read replica.
    if (!(await eventBloomFilter.mightExist(id))) {
      throw new NotFoundError('Event');
    }

    const { value: event, hit } = await cacheAside(cacheKeys.eventDetail(id), CACHE_TTL_SECONDS.eventDetail, () =>
      readDB.run((db) => db.event.findUnique({ where: { id }, include: { venue: { include: { sections: true } } } }))
    );
    (hit ? redisCacheHits : redisCacheMisses).inc({ cache: 'event_detail' });

    if (!event) throw new NotFoundError('Event');
    res.status(200).json({ success: true, data: event });
  })
);

const createEventSchema = z.object({
  venueId: z.string().uuid(),
  name: z.string().min(1).max(200),
  description: z.string().min(1),
  category: z.string().min(1).max(60),
  tags: z.array(z.string()).default([]),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  basePrice: z.number().positive(),
});

router.post(
  '/',
  authenticate,
  authorize('ADMIN'),
  validateBody(createEventSchema),
  asyncHandler(async (req, res) => {
    const body = req.body;
    const venue = await writeDB.venue.findUnique({ where: { id: body.venueId }, include: { sections: { include: { seats: true } } } });
    if (!venue) throw new NotFoundError('Venue');

    const event = await writeDB.$transaction(async (tx) => {
      const created = await tx.event.create({
        data: {
          venueId: body.venueId,
          name: body.name,
          description: body.description,
          category: body.category,
          tags: body.tags,
          startsAt: new Date(body.startsAt),
          endsAt: new Date(body.endsAt),
          basePrice: body.basePrice,
          status: 'PUBLISHED',
          createdById: req.user!.sub,
        },
      });

      const eventSeatRows = venue.sections.flatMap((section) =>
        section.seats.map((seat) => ({
          eventId: created.id,
          seatId: seat.id,
          status: 'AVAILABLE' as const,
          price: Number(body.basePrice) * (section.name === 'Floor' ? 1.5 : 1),
        }))
      );
      if (eventSeatRows.length > 0) {
        await tx.eventSeat.createMany({ data: eventSeatRows });
      }

      return created;
    });

    await eventBloomFilter.add(event.id);
    await eventSeatBloomFilter.addMany(
      venue.sections.flatMap((section) => section.seats.map((seat) => `${event.id}:${seat.id}`))
    );
    recordAuditLog({ actorId: req.user!.sub, action: 'EVENT_CREATED', resourceType: 'event', resourceId: event.id, requestId: req.requestId });
    await publishEvent(RoutingKey.EventCreated, { eventId: event.id, name: event.name, category: event.category }, req.requestId);

    res.status(201).json({ success: true, data: event });
  })
);

const updateEventSchema = createEventSchema.partial();

router.put(
  '/:id',
  authenticate,
  authorize('ADMIN'),
  validateBody(updateEventSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const existing = await writeDB.event.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Event');

    const body = req.body;
    const event = await writeDB.event.update({
      where: { id },
      data: {
        ...(body.venueId ? { venueId: body.venueId } : {}),
        ...(body.name ? { name: body.name } : {}),
        ...(body.description ? { description: body.description } : {}),
        ...(body.category ? { category: body.category } : {}),
        ...(body.tags ? { tags: body.tags } : {}),
        ...(body.startsAt ? { startsAt: new Date(body.startsAt) } : {}),
        ...(body.endsAt ? { endsAt: new Date(body.endsAt) } : {}),
        ...(body.basePrice !== undefined ? { basePrice: body.basePrice } : {}),
      },
    });

    await cacheInvalidate(cacheKeys.eventDetail(id), cacheKeys.eventAvailability(id));
    recordAuditLog({ actorId: req.user!.sub, action: 'EVENT_UPDATED', resourceType: 'event', resourceId: id, requestId: req.requestId });
    await publishEvent(RoutingKey.EventCreated, { eventId: event.id, name: event.name, category: event.category, updated: true }, req.requestId);

    res.status(200).json({ success: true, data: event });
  })
);

router.delete(
  '/:id',
  authenticate,
  authorize('ADMIN'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const existing = await writeDB.event.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Event');

    await writeDB.event.update({ where: { id }, data: { status: 'CANCELLED' } });
    await cacheInvalidate(cacheKeys.eventDetail(id), cacheKeys.eventAvailability(id));
    recordAuditLog({ actorId: req.user!.sub, action: 'EVENT_DELETED', resourceType: 'event', resourceId: id, requestId: req.requestId });

    res.status(200).json({ success: true, message: 'Event cancelled' });
  })
);
