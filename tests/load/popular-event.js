// Scenario: "Popular event" - 10,000 concurrent users searching for and
// viewing one trending event (search index + cache layer under heavy
// read load). Run with:
//   k6 run -e QUERY=concert tests/load/popular-event.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL } from './k6-config.js';

const QUERY = __ENV.QUERY || 'concert';

export const options = {
  scenarios: {
    popular_event: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 3000 },
        { duration: '1m', target: 10000 },
        { duration: '2m', target: 10000 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    http_req_failed: ['rate<0.03'],
  },
};

export default function () {
  const searchRes = http.get(`${BASE_URL}/search/events?q=${QUERY}`);
  check(searchRes, { 'search 200': (r) => r.status === 200 });

  const body = JSON.parse(searchRes.body);
  if (body.results && body.results.length > 0) {
    const pick = body.results[0];
    const detailRes = http.get(`${BASE_URL}/events/${pick.eventId}`);
    check(detailRes, { 'event detail 200': (r) => r.status === 200 });
  }

  sleep(Math.random() * 1.5);
}
