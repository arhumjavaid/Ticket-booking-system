import '../setupIntegrationEnv';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { signAccessToken } from '@ticketing/auth';

// Section 26 / 36: the single most important correctness property of this
// entire system. N concurrent requests for the SAME seat must yield
// exactly one winner - never zero, never two - regardless of how many
// stateless API instances (api-1/2/3) happen to receive them.
const BASE_URL = process.env.API_BASE_URL || 'http://localhost:8080/api';
const CONCURRENT_USERS = parseInt(process.env.SEAT_RACE_USERS || '100', 10);

// Users are registered through the real API, but their tokens are signed
// here rather than via /auth/login: login is rate limited per client IP
// (5/min by default) and every simulated user shares this machine's IP, so
// logging in 100 of them would take 20 minutes. Login itself is covered by
// tests/integration/bookingWorkflow.test.ts. Requires the same JWT_SECRET
// as the stack (setupIntegrationEnv defaults to the docker-compose one).
async function registerUser(email: string): Promise<string> {
  const client = axios.create({ baseURL: BASE_URL, validateStatus: () => true });
  const res = await client.post('/auth/register', { email, password: 'Password123!', name: 'Racer' });
  if (res.status !== 201) throw new Error(`Unexpected register status ${res.status}: ${JSON.stringify(res.data)}`);
  return signAccessToken({ sub: res.data.data.id, email, role: 'USER' }).token;
}

describe(`Concurrent seat hold race (${CONCURRENT_USERS} simultaneous users, one seat)`, () => {
  jest.setTimeout(120000);

  it('lets exactly one user hold the seat and rejects everyone else with 409', async () => {
    const anon = axios.create({ baseURL: BASE_URL, validateStatus: () => true });
    const eventsResponse = await anon.get('/events');
    const eventId = eventsResponse.data.data[0].id;
    const seatsResponse = await anon.get(`/events/${eventId}/seats`);
    const targetSeat = seatsResponse.data.data.find((s: any) => s.status === 'AVAILABLE');
    expect(targetSeat).toBeDefined();
    const seatId = targetSeat.seatId;

    const runId = Date.now();
    const tokens = await Promise.all(
      Array.from({ length: CONCURRENT_USERS }, (_, i) => registerUser(`racer-${runId}-${i}@example.com`))
    );

    // Fire every request at (as close to) the exact same instant as
    // possible - this is what forces Nginx to spread them across
    // api-1/2/3 and forces the Redis lock + Postgres FOR UPDATE to be the
    // things that decide the winner, not request ordering on one process.
    const results = await Promise.allSettled(
      tokens.map((token) =>
        axios.post(
          `${BASE_URL}/events/${eventId}/seats/hold`,
          { seatId },
          { headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true }
        )
      )
    );

    const statuses = results.map((r) =>
      r.status === 'fulfilled' ? r.value.status : `ERR:${(r.reason as Error).message}`
    );
    const successCount = statuses.filter((s) => s === 201).length;
    const conflictCount = statuses.filter((s) => s === 409).length;

    if (successCount !== 1 || conflictCount !== CONCURRENT_USERS - 1) {
      const tally: Record<string, number> = {};
      for (const s of statuses) tally[String(s)] = (tally[String(s)] || 0) + 1;
      // eslint-disable-next-line no-console
      console.log('Status tally:', tally);
    }

    expect(successCount).toBe(1); // exactly one winner - never zero, never many
    expect(conflictCount).toBe(CONCURRENT_USERS - 1);
  });

  it('never creates two bookings for the same event+seat under concurrent booking attempts', async () => {
    const anon = axios.create({ baseURL: BASE_URL, validateStatus: () => true });
    const eventsResponse = await anon.get('/events');
    const eventId = eventsResponse.data.data[0].id;
    const seatsResponse = await anon.get(`/events/${eventId}/seats`);
    const targetSeat = seatsResponse.data.data.find((s: any) => s.status === 'AVAILABLE');
    expect(targetSeat).toBeDefined();
    const seatId = targetSeat.seatId;

    const runId = Date.now();
    const tokens = await Promise.all(
      Array.from({ length: CONCURRENT_USERS }, (_, i) => registerUser(`booker-${runId}-${i}@example.com`))
    );

    // Every request uses its OWN Idempotency-Key here (they are genuinely
    // different booking attempts by different users) - the seat-level lock
    // + FOR UPDATE + optimistic version check is what has to prevent the
    // double-booking, not the idempotency layer.
    const results = await Promise.allSettled(
      tokens.map((token) =>
        axios.post(
          `${BASE_URL}/bookings`,
          { eventId, seatIds: [seatId] },
          { headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': randomUUID() }, validateStatus: () => true }
        )
      )
    );

    const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : -1));
    const successCount = statuses.filter((s) => s === 201).length;

    // Each 201 is a PENDING checkout holding the seat for Stripe payment;
    // only the webhook can turn it into BOOKED, so one checkout = one booking.
    expect(successCount).toBe(1); // RULE 12: no seat can be booked twice
    expect(statuses.filter((s) => s === 409).length).toBe(CONCURRENT_USERS - 1);

    // Remaining-seat counts (cached, per tier) reflect the single winner.
    const availability = (await anon.get(`/events/${eventId}/availability`)).data.data;
    expect(availability.HELD).toBeGreaterThanOrEqual(1);
    expect(Object.keys(availability.byTier).length).toBeGreaterThan(0);
  });
});
