// Scenario: "Event opening" - 5000 concurrent users hitting a single
// event's seat map the moment tickets go on sale (a hot-key read spike on
// one event_id, testing the Redis cache-aside layer under load). Run with:
//   k6 run -e EVENT_ID=<uuid> tests/load/event-opening.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL } from './k6-config.js';

const EVENT_ID = __ENV.EVENT_ID;

export const options = {
  scenarios: {
    event_opening: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: 2000 },
        { duration: '30s', target: 5000 },
        { duration: '1m', target: 5000 },
        { duration: '15s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<800'],
    http_req_failed: ['rate<0.02'],
  },
};

export default function () {
  if (!EVENT_ID) {
    throw new Error('Pass -e EVENT_ID=<uuid> (see docs/LOAD_TESTING.md)');
  }

  const seatsRes = http.get(`${BASE_URL}/events/${EVENT_ID}/seats`);
  check(seatsRes, { 'seat map 200': (r) => r.status === 200 });

  const availabilityRes = http.get(`${BASE_URL}/events/${EVENT_ID}/availability`);
  check(availabilityRes, { 'availability 200': (r) => r.status === 200 });

  sleep(Math.random());
}
