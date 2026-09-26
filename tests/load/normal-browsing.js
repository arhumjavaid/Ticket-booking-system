// Scenario: "Normal browsing" - 1000 concurrent users browsing events and
// checking seat availability (read-heavy, cache-aside path). Run with:
//   k6 run tests/load/normal-browsing.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL } from './k6-config.js';

export const options = {
  scenarios: {
    normal_browsing: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 300 },
        { duration: '1m', target: 1000 },
        { duration: '2m', target: 1000 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1500'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const listRes = http.get(`${BASE_URL}/events`);
  check(listRes, { 'list events 200': (r) => r.status === 200 });

  const events = JSON.parse(listRes.body).data;
  if (events && events.length > 0) {
    const event = events[Math.floor(Math.random() * events.length)];

    const detailRes = http.get(`${BASE_URL}/events/${event.id}`);
    check(detailRes, { 'event detail 200': (r) => r.status === 200 });

    const availabilityRes = http.get(`${BASE_URL}/events/${event.id}/availability`);
    check(availabilityRes, { 'availability 200': (r) => r.status === 200 });
  }

  sleep(Math.random() * 2);
}
