import '../setupIntegrationEnv';
import { writeDB, readDB, disconnectAll } from '@ticketing/database';

describe('PostgreSQL primary/replica read-write separation', () => {
  afterAll(async () => {
    await disconnectAll();
  });

  it('writes through the primary and can read it back immediately from the primary', async () => {
    const email = `it-${Date.now()}@example.com`;
    const user = await writeDB.user.create({
      data: { email, passwordHash: 'x', name: 'Integration Test', role: 'USER' },
    });
    expect(user.id).toBeDefined();

    const fetched = await writeDB.user.findUnique({ where: { id: user.id } });
    expect(fetched?.email).toBe(email);
  });

  it('becomes visible on a read replica once streaming replication catches up', async () => {
    const email = `it-replica-${Date.now()}@example.com`;
    const user = await writeDB.user.create({
      data: { email, passwordHash: 'x', name: 'Replica Test', role: 'USER' },
    });

    // Streaming replication is asynchronous (documented in
    // docs/DISTRIBUTED_SYSTEMS.md) - poll briefly rather than assume
    // instant consistency, which is exactly the tradeoff RULE-documented
    // for reads that don't need to be on the critical booking path.
    let found = null;
    for (let attempt = 0; attempt < 20 && !found; attempt++) {
      found = await readDB.run((db) => db.user.findUnique({ where: { id: user.id } }));
      if (!found) await new Promise((r) => setTimeout(r, 250));
    }

    expect(found?.email).toBe(email);
  });

  it('enforces the booking idempotency_key uniqueness constraint at the database level', async () => {
    const [venue] = await writeDB.venue.findMany({ take: 1 });
    const [event] = await writeDB.event.findMany({ take: 1 });
    if (!venue || !event) {
      // Seed data not present in this environment - skip rather than fail.
      return;
    }

    const user = await writeDB.user.create({
      data: { email: `it-idem-${Date.now()}@example.com`, passwordHash: 'x', name: 'Idempotency Test', role: 'USER' },
    });

    const key = `idem-${Date.now()}`;
    await writeDB.booking.create({
      data: { userId: user.id, eventId: event.id, status: 'CONFIRMED', totalAmount: 10, idempotencyKey: key },
    });

    await expect(
      writeDB.booking.create({
        data: { userId: user.id, eventId: event.id, status: 'CONFIRMED', totalAmount: 10, idempotencyKey: key },
      })
    ).rejects.toThrow();
  });
});
