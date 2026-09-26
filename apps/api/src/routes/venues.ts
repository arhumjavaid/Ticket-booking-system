import { Router } from 'express';
import { z } from 'zod';
import { writeDB, readDB, recordAuditLog } from '@ticketing/database';
import { authenticate, authorize } from '@ticketing/auth';
import { asyncHandler, validateBody, NotFoundError } from '@ticketing/shared';

export const router = Router();

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const venues = await readDB.run((db) => db.venue.findMany({ include: { sections: true } }));
    res.status(200).json({ success: true, data: venues });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const venue = await readDB.run((db) =>
      db.venue.findUnique({ where: { id: req.params.id }, include: { sections: { include: { seats: true } } } })
    );
    if (!venue) throw new NotFoundError('Venue');
    res.status(200).json({ success: true, data: venue });
  })
);

const seatingSectionSchema = z.object({
  name: z.string().min(1).max(100),
  rows: z.array(z.string().min(1)),
  seatsPerRow: z.number().int().positive().max(200),
  seatType: z.string().default('REGULAR'),
});

const createVenueSchema = z.object({
  name: z.string().min(1).max(200),
  city: z.string().min(1).max(100),
  address: z.string().min(1).max(300),
  sections: z.array(seatingSectionSchema).min(1),
});

router.post(
  '/',
  authenticate,
  authorize('ADMIN'),
  validateBody(createVenueSchema),
  asyncHandler(async (req, res) => {
    const body = req.body;
    const venue = await writeDB.$transaction(async (tx) => {
      const created = await tx.venue.create({ data: { name: body.name, city: body.city, address: body.address } });

      for (const sectionDef of body.sections) {
        const section = await tx.venueSection.create({ data: { venueId: created.id, name: sectionDef.name } });
        const seatRows = sectionDef.rows.flatMap((row: string) =>
          Array.from({ length: sectionDef.seatsPerRow }, (_, idx) => ({
            venueSectionId: section.id,
            rowLabel: row,
            seatNumber: idx + 1,
            seatType: sectionDef.seatType,
          }))
        );
        await tx.seat.createMany({ data: seatRows });
      }

      return created;
    });

    recordAuditLog({ actorId: req.user!.sub, action: 'VENUE_CREATED', resourceType: 'venue', resourceId: venue.id, requestId: req.requestId });
    res.status(201).json({ success: true, data: venue });
  })
);
