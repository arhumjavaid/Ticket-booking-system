import '../setupIntegrationEnv';
import axios from 'axios';
import { randomUUID } from 'crypto';

// Section 26 / 36: the single most important correctness property of this
// entire system. N concurrent requests for the SAME seat must yield
// exactly one winner - never zero, never two - regardless of how many
// stateless API instances (api-1/2/3) happen to receive them.
const BASE_URL = process.env.API_BASE_URL || 'http://localhost:8080/api';
const CONCURRENT_USERS = parseInt(process.env.SEAT_RACE_USERS || '100', 10);

async function registerAndLogin(email: string): Promise<string> {
  const client = axios.create({ baseURL: BASE_URL, validateStatus: () => true });
  await client.post('/auth/register', { email, password: 'Password123!', name: 'Racer' });

  // The login rate limiter (5/min/IP by default) is a real feature being
  // exercised here too, since every simulated "user" logs in from the same
  // test-runner IP. Retry with backoff rather than raising the limit just
  // for this test - a real distributed client pool wouldn't share one IP.
  for (let attempt = 0; attempt < 20; attempt++) {
    const login = await client.post('/auth/login', { email, password: 'Password123!' });
    if (login.status === 200) return login.data.data.token;
    if (login.status === 429) {
      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 500));
      continue;
    }
    throw new Error(`Unexpected login status ${login.status}: ${JSON.stringify(login.data)}`);
  }
  throw new Error(`Login rate-limited for too long for ${email}`);
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
      Array.from({ length: CONCURRENT_USERS }, (_, i) => registerAndLogin(`racer-${runId}-${i}@example.com`))
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
      Array.from({ length: CONCURRENT_USERS }, (_, i) => registerAndLogin(`booker-${runId}-${i}@example.com`))
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

    expect(successCount).toBe(1); // RULE 12: no seat can be booked twice
  });
});
