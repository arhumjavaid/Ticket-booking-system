import '../setupIntegrationEnv';
import axios from 'axios';
import { randomUUID } from 'crypto';

// This test exercises the FULL stack through Nginx (client -> Nginx ->
// api-N -> Booking Service -> Postgres/Redis/RabbitMQ), matching section 38
// ("load testing must hit Nginx rather than a single API server"). It
// requires `docker compose up` to be running with at least infra + api-1/2/3
// + booking-service + nginx + a migrated & seeded database.
const BASE_URL = process.env.API_BASE_URL || 'http://localhost:8080/api';
const client = axios.create({ baseURL: BASE_URL, validateStatus: () => true });

describe('End-to-end booking workflow (through Nginx)', () => {
  let token: string;
  let eventId: string;
  let bookingId: string;

  it('registers and logs in a new user', async () => {
    const email = `e2e-${Date.now()}@example.com`;
    const register = await client.post('/auth/register', { email, password: 'Password123!', name: 'E2E User' });
    expect(register.status).toBe(201);

    const login = await client.post('/auth/login', { email, password: 'Password123!' });
    expect(login.status).toBe(200);
    token = login.data.data.token;
    client.defaults.headers.common.Authorization = `Bearer ${token}`;
  });

  it('browses published events', async () => {
    const response = await client.get('/events');
    expect(response.status).toBe(200);
    expect(response.data.data.length).toBeGreaterThan(0);
    eventId = response.data.data[0].id;
  });

  let seatId: string;

  it('holds an available seat', async () => {
    const seatsResponse = await client.get(`/events/${eventId}/seats`);
    const available = seatsResponse.data.data.find((s: any) => s.status === 'AVAILABLE');
    expect(available).toBeDefined();
    seatId = available.seatId;

    const hold = await client.post(`/events/${eventId}/seats/hold`, { seatId });
    expect(hold.status).toBe(201);
    expect(hold.data.data.status).toBe('HELD');
  });

  it('confirms a booking for the held seat', async () => {
    const idempotencyKey = randomUUID();
    const response = await client.post(
      '/bookings',
      { eventId, seatIds: [seatId] },
      { headers: { 'Idempotency-Key': idempotencyKey } }
    );
    expect(response.status).toBe(201);
    expect(response.data.data.status).toBe('CONFIRMED');
    bookingId = response.data.data.id;

    // Replaying the exact same Idempotency-Key must return the SAME
    // booking, never create a second one (RULE 5 / section 17).
    const replay = await client.post(
      '/bookings',
      { eventId, seatIds: [seatId] },
      { headers: { 'Idempotency-Key': idempotencyKey } }
    );
    expect(replay.status).toBe(200);
    expect(replay.data.data.id).toBe(bookingId);
  });

  it('lists the booking in booking history and fetches it by id', async () => {
    const list = await client.get('/bookings');
    expect(list.data.data.some((b: any) => b.id === bookingId)).toBe(true);

    const detail = await client.get(`/bookings/${bookingId}`);
    expect(detail.status).toBe(200);
    expect(detail.data.data.id).toBe(bookingId);
  });

  it('cancels the booking and releases the seat back to AVAILABLE', async () => {
    const cancel = await client.post(`/bookings/${bookingId}/cancel`);
    expect(cancel.status).toBe(200);

    // seat release is published async; poll briefly for consistency
    let seat = null;
    for (let i = 0; i < 20; i++) {
      const seatsResponse = await client.get(`/events/${eventId}/seats`);
      seat = seatsResponse.data.data.find((s: any) => s.seatId === seatId);
      if (seat?.status === 'AVAILABLE') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(seat?.status).toBe('AVAILABLE');
  });
});
