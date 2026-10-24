import * as crypto from 'crypto';
import express, { Router } from 'express';
import { z } from 'zod';
import { writeDB, readDB, recordAuditLog } from '@ticketing/database';
import { authenticate, authorize, optionalAuthenticate } from '@ticketing/auth';
import { eventBloomFilter, eventSeatBloomFilter, cacheAside, cacheInvalidate, cacheKeys } from '@ticketing/redis';
import { publishEvent, RoutingKey } from '@ticketing/messaging';
import { redisCacheHits, redisCacheMisses } from '@ticketing/metrics';
import {
  asyncHandler,
  validateBody,
  NotFoundError,
  ValidationError,
  CACHE_TTL_SECONDS,
  RATE_LIMITS,
  seatTierPrice,
  sniffImageType,
  EVENT_IMAGE_MAX_BYTES,
} from '@ticketing/shared';
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

    // Remaining inventory per event, for "only N left" badges on listings.
    const available = await readDB.run((db) =>
      db.eventSeat.groupBy({
        by: ['eventId'],
        where: { status: 'AVAILABLE', eventId: { in: events.map((e) => e.id) } },
        _count: { _all: true },
      })
    );
    const availableByEvent = new Map(available.map((row) => [row.eventId, row._count._all]));
    const data = events.map((e) => ({ ...e, availableSeats: availableByEvent.get(e.id) ?? 0 }));

    res.status(200).json({ success: true, data, pagination: { page, pageSize, total } });
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
  // Optional explicit price per seat tier; tiers left out use basePrice x multiplier.
  tierPrices: z
    .object({ VIP: z.number().positive(), PREMIUM: z.number().positive(), REGULAR: z.number().positive() })
    .partial()
    .optional(),
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

    // Bloom filters learn the ids before the rows exist (see auth register):
    // never a committed event/seat that a filter calls "absent".
    const eventId = crypto.randomUUID();
    await eventBloomFilter.add(eventId);
    await eventSeatBloomFilter.addMany(venue.sections.flatMap((section) => section.seats.map((seat) => `${eventId}:${seat.id}`)));

    const event = await writeDB.$transaction(async (tx) => {
      const created = await tx.event.create({
        data: {
          id: eventId,
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
          price: seatTierPrice(Number(body.basePrice), seat.seatType, body.tierPrices),
        }))
      );
      if (eventSeatRows.length > 0) {
        await tx.eventSeat.createMany({ data: eventSeatRows });
      }

      return created;
    });

    recordAuditLog({ actorId: req.user!.sub, action: 'EVENT_CREATED', resourceType: 'event', resourceId: event.id, requestId: req.requestId });
    await publishEvent(RoutingKey.EventCreated, { eventId: event.id, name: event.name, category: event.category }, req.requestId);

    res.status(201).json({ success: true, data: event });
  })
);

// ---- Event image (admin upload, public read) ----

router.get(
  '/:id/image',
  asyncHandler(async (req, res) => {
    const image = await readDB.run((db) => db.eventImage.findUnique({ where: { eventId: req.params.id } }));
    if (!image) throw new NotFoundError('Event image');
    // URLs carry ?v=<imageUpdatedAt>, so a new upload gets a new URL and this can be cached hard.
    res.set('Content-Type', image.contentType);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('X-Content-Type-Options', 'nosniff');
    res.status(200).send(Buffer.from(image.data));
  })
);

router.put(
  '/:id/image',
  authenticate,
  authorize('ADMIN'),
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: EVENT_IMAGE_MAX_BYTES }),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new ValidationError('Send a JPEG, PNG or WebP image as the request body (max 2 MB).');
    }
    const contentType = sniffImageType(body);
    if (!contentType) throw new ValidationError('File is not a valid JPEG, PNG or WebP image.');

    const existing = await writeDB.event.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundError('Event');

    const now = new Date();
    await writeDB.$transaction([
      writeDB.eventImage.upsert({
        where: { eventId: id },
        create: { eventId: id, contentType, data: body },
        update: { contentType, data: body, createdAt: now },
      }),
      writeDB.event.update({ where: { id }, data: { imageUpdatedAt: now } }),
    ]);

    await cacheInvalidate(cacheKeys.eventDetail(id));
    recordAuditLog({ actorId: req.user!.sub, action: 'EVENT_IMAGE_UPDATED', resourceType: 'event', resourceId: id, requestId: req.requestId });
    res.status(200).json({ success: true, data: { imageUpdatedAt: now.toISOString() } });
  })
);

router.delete(
  '/:id/image',
  authenticate,
  authorize('ADMIN'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    await writeDB.$transaction([
      writeDB.eventImage.deleteMany({ where: { eventId: id } }),
      writeDB.event.updateMany({ where: { id }, data: { imageUpdatedAt: null } }),
    ]);
    await cacheInvalidate(cacheKeys.eventDetail(id));
    recordAuditLog({ actorId: req.user!.sub, action: 'EVENT_IMAGE_REMOVED', resourceType: 'event', resourceId: id, requestId: req.requestId });
    res.status(200).json({ success: true });
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
