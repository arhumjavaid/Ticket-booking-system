import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;

async function hashPassword(pw: string) {
  return bcrypt.hash(pw, 10);
}

async function main() {
  console.log('Seeding database...');

  const adminPassword = await hashPassword('Admin123!');
  const userPassword = await hashPassword('Password123!');

  const admin = await prisma.user.upsert({
    where: { email: 'admin@ticketing.dev' },
    update: {},
    create: {
      email: 'admin@ticketing.dev',
      passwordHash: adminPassword,
      name: 'System Admin',
      role: 'ADMIN',
    },
  });

  const users = [];
  for (let i = 1; i <= 5; i++) {
    const user = await prisma.user.upsert({
      where: { email: `user${i}@ticketing.dev` },
      update: {},
      create: {
        email: `user${i}@ticketing.dev`,
        passwordHash: userPassword,
        name: `Demo User ${i}`,
        role: 'USER',
      },
    });
    users.push(user);
  }

  const venueDefs = [
    { name: 'Skyline Arena', city: 'New York', address: '1 Arena Plaza, New York, NY' },
    { name: 'Riverside Hall', city: 'Austin', address: '200 Riverside Dr, Austin, TX' },
    { name: 'Grand Pavilion', city: 'Seattle', address: '55 Pavilion Way, Seattle, WA' },
  ];

  const venues = [];
  for (const def of venueDefs) {
    let venue = await prisma.venue.findFirst({ where: { name: def.name } });
    if (!venue) {
      venue = await prisma.venue.create({ data: def });
    }

    const sectionDefs = [
      { name: 'Floor', seatType: 'VIP' },
      { name: 'Upper Bowl', seatType: 'REGULAR' },
    ];

    const sections = [];
    for (const sectionDef of sectionDefs) {
      let section = await prisma.venueSection.findFirst({
        where: { venueId: venue.id, name: sectionDef.name },
      });
      if (!section) {
        section = await prisma.venueSection.create({
          data: { venueId: venue.id, name: sectionDef.name },
        });
      }

      const existingSeats = await prisma.seat.count({ where: { venueSectionId: section.id } });
      if (existingSeats === 0) {
        const seatRows = ROWS.flatMap((row) =>
          Array.from({ length: SEATS_PER_ROW }, (_, idx) => ({
            venueSectionId: section!.id,
            rowLabel: row,
            seatNumber: idx + 1,
            seatType: sectionDef.seatType,
          }))
        );
        await prisma.seat.createMany({ data: seatRows });
      }

      sections.push(section);
    }

    venues.push({ venue, sections });
  }

  const eventDefs = [
    {
      name: 'Neon Skyline Concert',
      description: 'An electrifying night of synth-pop under the stars.',
      category: 'Concert',
      tags: ['music', 'live', 'pop'],
      venueIdx: 0,
      daysFromNow: 14,
      basePrice: 75,
    },
    {
      name: 'Shakespeare in the Hall',
      description: 'A modern retelling of Hamlet performed by the city theater troupe.',
      category: 'Theater',
      tags: ['theater', 'drama', 'classic'],
      venueIdx: 1,
      daysFromNow: 21,
      basePrice: 45,
    },
    {
      name: 'Championship Finals',
      description: 'The season finale - two undefeated teams, one trophy.',
      category: 'Sports',
      tags: ['sports', 'finals'],
      venueIdx: 2,
      daysFromNow: 7,
      basePrice: 120,
    },
    {
      name: 'Stand-Up Spectacular',
      description: 'Five headline comedians, one unforgettable night.',
      category: 'Comedy',
      tags: ['comedy', 'live'],
      venueIdx: 0,
      daysFromNow: 30,
      basePrice: 40,
    },
    {
      name: 'Riverside Music Festival',
      description: 'A full-day, multi-stage music festival on the riverfront.',
      category: 'Festival',
      tags: ['music', 'festival', 'outdoor'],
      venueIdx: 1,
      daysFromNow: 45,
      basePrice: 95,
    },
    {
      name: 'Future of Tech Conference',
      description: 'Talks and workshops on distributed systems and AI.',
      category: 'Conference',
      tags: ['tech', 'conference'],
      venueIdx: 2,
      daysFromNow: 60,
      basePrice: 150,
    },
  ];

  for (const def of eventDefs) {
    let event = await prisma.event.findFirst({ where: { name: def.name } });
    const { venue, sections } = venues[def.venueIdx];
    const startsAt = new Date(Date.now() + def.daysFromNow * 24 * 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 3 * 60 * 60 * 1000);

    if (!event) {
      event = await prisma.event.create({
        data: {
          venueId: venue.id,
          name: def.name,
          description: def.description,
          category: def.category,
          tags: def.tags,
          startsAt,
          endsAt,
          basePrice: def.basePrice,
          status: 'PUBLISHED',
          createdById: admin.id,
        },
      });
    }

    const existingEventSeats = await prisma.eventSeat.count({ where: { eventId: event.id } });
    if (existingEventSeats === 0) {
      for (const section of sections) {
        const seats = await prisma.seat.findMany({ where: { venueSectionId: section.id } });
        const priceMultiplier = section.name === 'Floor' ? 1.5 : 1;
        const eventSeatRows = seats.map((seat) => ({
          eventId: event!.id,
          seatId: seat.id,
          status: 'AVAILABLE' as const,
          price: Number(def.basePrice) * priceMultiplier,
        }));
        await prisma.eventSeat.createMany({ data: eventSeatRows });
      }
    }
  }

  console.log('Seed complete.');
  console.log(`Admin login: admin@ticketing.dev / Admin123!`);
  console.log(`User logins: user1..5@ticketing.dev / Password123!`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
