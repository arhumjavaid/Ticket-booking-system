// Scenario: "Flash sale" - 10,000+ concurrent booking ATTEMPTS competing
// for a small pool of seats on one event. This is the load-test-scale
// version of the concurrency test in tests/concurrency/seatRace.test.ts:
// here we care about throughput/latency/error-rate under real load, not
// just correctness with a handful of requests.
//
// NOTE: k6's `setup()` runs once, effectively single-threaded, and logs in
// a pool of users up front so the booking-attempt phase isn't itself
// throttled by the per-IP login rate limit. If you see setup() taking a
// long time, temporarily raise RATE_LIMIT_LOGIN_PER_MIN in .env for this
// run - see docs/LOAD_TESTING.md.
//
// Run with:
//   k6 run -e EVENT_ID=<uuid> tests/load/flash-sale.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { BASE_URL } from './k6-config.js';

const EVENT_ID = __ENV.EVENT_ID;
const USER_POOL_SIZE = parseInt(__ENV.USER_POOL_SIZE || '100', 10);

export const bookingSuccessRate = new Rate('booking_success_rate');
export const bookingConflictRate = new Rate('booking_conflict_rate');
export const bookingLatency = new Trend('booking_latency_ms');

export const options = {
  scenarios: {
    flash_sale: {
      executor: 'ramping-arrival-rate',
      startRate: 100,
      timeUnit: '1s',
      preAllocatedVUs: 2000,
      maxVUs: 12000,
      stages: [
        { target: 2000, duration: '20s' },
        { target: 10000, duration: '40s' },
        { target: 10000, duration: '30s' },
        { target: 0, duration: '10s' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.5'], // 409 Conflict is an EXPECTED outcome here, not a failure
  },
};

export function setup() {
  if (!EVENT_ID) {
    throw new Error('Pass -e EVENT_ID=<uuid> (see docs/LOAD_TESTING.md)');
  }

  const tokens = [];
  for (let i = 0; i < USER_POOL_SIZE; i++) {
    const email = `flashsale-${Date.now()}-${i}@example.com`;
    http.post(
      `${BASE_URL}/auth/register`,
      JSON.stringify({ email, password: 'Password123!', name: 'Flash Sale User' }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    const login = http.post(
      `${BASE_URL}/auth/login`,
      JSON.stringify({ email, password: 'Password123!' }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    if (login.status === 200) {
      tokens.push(JSON.parse(login.body).data.token);
    }
  }

  const seatsRes = http.get(`${BASE_URL}/events/${EVENT_ID}/seats`);
  const seats = JSON.parse(seatsRes.body).data.filter((s) => s.status === 'AVAILABLE').slice(0, 10);

  return { tokens, seatIds: seats.map((s) => s.seatId) };
}

export default function (data) {
  if (data.tokens.length === 0 || data.seatIds.length === 0) return;

  const token = data.tokens[Math.floor(Math.random() * data.tokens.length)];
  const seatId = data.seatIds[Math.floor(Math.random() * data.seatIds.length)];
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const start = Date.now();
  const bookingRes = http.post(
    `${BASE_URL}/bookings`,
    JSON.stringify({ eventId: EVENT_ID, seatIds: [seatId] }),
    { headers: { ...headers, 'Idempotency-Key': `${__VU}-${__ITER}-${Date.now()}` } }
  );
  bookingLatency.add(Date.now() - start);

  const succeeded = bookingRes.status === 201;
  const conflicted = bookingRes.status === 409;
  bookingSuccessRate.add(succeeded);
  bookingConflictRate.add(conflicted);

  check(bookingRes, {
    'booking succeeded or was a correctly-rejected conflict': (r) => r.status === 201 || r.status === 409,
  });

  sleep(0.1);
}
