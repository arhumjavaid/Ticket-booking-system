const tx = {
  $queryRaw: jest.fn(),
  eventSeat: { updateMany: jest.fn() },
  seatHold: { create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
};

jest.mock('@ticketing/database', () => ({
  writeDB: { $queryRaw: jest.fn(), $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)) },
  Prisma: { sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }) },
}));

jest.mock('@ticketing/redis', () => ({
  withLock: jest.fn((_resource: string, _ttl: number, fn: () => unknown) => fn()),
  cacheInvalidate: jest.fn(),
  cacheKeys: {
    eventAvailability: (id: string) => `event:${id}:availability`,
    seatStatus: (e: string, s: string) => `seat:${e}:${s}`,
    seatHold: (e: string, s: string) => `hold:${e}:${s}`,
  },
  redis: { set: jest.fn(), del: jest.fn() },
  eventSeatBloomFilter: { mightExist: jest.fn().mockResolvedValue(true) },
  LockAcquisitionError: class LockAcquisitionError extends Error {},
}));

jest.mock('@ticketing/messaging', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
  RoutingKey: { SeatHeld: 'seat.held', SeatReleased: 'seat.released' },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { writeDB } = require('@ticketing/database');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { publishEvent } = require('@ticketing/messaging');
import { sweepExpiredHolds } from '@ticketing/worker/dist/holdExpiry';
import { holdSeat } from '@ticketing/booking-service/dist/services/holdService';

const expiredHold = { id: 'hold-1', event_id: 'event-1', seat_id: 'seat-1', event_seat_id: 'es-1', user_id: 'user-1' };

beforeEach(() => {
  jest.clearAllMocks();
  tx.eventSeat.updateMany.mockResolvedValue({ count: 1 });
});

describe('Expired hold sweep (worker)', () => {
  it('returns a seat still held by the expired holder to AVAILABLE and announces it', async () => {
    writeDB.$queryRaw.mockResolvedValue([expiredHold]);
    tx.$queryRaw.mockResolvedValue([{ id: 'es-1', status: 'HELD', held_by: 'user-1', version: 3 }]);

    expect(await sweepExpiredHolds()).toBe(1);

    expect(tx.eventSeat.updateMany).toHaveBeenCalledWith({
      where: { id: 'es-1', version: 3 },
      data: { status: 'AVAILABLE', heldBy: null, holdExpiresAt: null, version: { increment: 1 } },
    });
    expect(tx.seatHold.update).toHaveBeenCalledWith({ where: { id: 'hold-1' }, data: { status: 'EXPIRED' } });
    expect(publishEvent).toHaveBeenCalledWith('seat.released', { eventId: 'event-1', seatId: 'seat-1', reason: 'hold_expired' });
  });

  it.each([
    ['booked', { status: 'BOOKED', held_by: null }],
    ['re-held by someone else', { status: 'HELD', held_by: 'user-2' }],
  ])('only closes the hold record when the seat was meanwhile %s', async (_label, seatState) => {
    writeDB.$queryRaw.mockResolvedValue([expiredHold]);
    tx.$queryRaw.mockResolvedValue([{ id: 'es-1', version: 3, ...seatState }]);

    expect(await sweepExpiredHolds()).toBe(0);

    expect(tx.eventSeat.updateMany).not.toHaveBeenCalled();
    expect(tx.seatHold.updateMany).toHaveBeenCalledWith({ where: { id: 'hold-1', status: 'ACTIVE' }, data: { status: 'EXPIRED' } });
    expect(publishEvent).not.toHaveBeenCalled();
  });
});

describe('Taking over a lapsed hold (booking service)', () => {
  const seatRow = (overrides: object) => ({
    id: 'es-1', event_id: 'event-1', seat_id: 'seat-1', price: '10.00', version: 3, held_by: null, hold_expires_at: null, ...overrides,
  });

  it("closes the previous holder's ACTIVE record before creating the new one", async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([seatRow({ status: 'HELD', held_by: 'user-1', hold_expires_at: new Date(Date.now() - 1000) })])
      .mockResolvedValueOnce([]); // not part of a pending checkout

    await holdSeat({ eventId: 'event-1', seatId: 'seat-1', userId: 'user-2' });

    expect(tx.seatHold.updateMany).toHaveBeenCalledWith({ where: { eventSeatId: 'es-1', status: 'ACTIVE' }, data: { status: 'EXPIRED' } });
    expect(tx.seatHold.updateMany.mock.invocationCallOrder[0]).toBeLessThan(tx.seatHold.create.mock.invocationCallOrder[0]);
  });

  it('refuses to take over a lapsed hold whose checkout payment may still land', async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([seatRow({ status: 'HELD', held_by: 'user-1', hold_expires_at: new Date(Date.now() - 1000) })])
      .mockResolvedValueOnce([{ '?column?': 1 }]);

    await expect(holdSeat({ eventId: 'event-1', seatId: 'seat-1', userId: 'user-2' })).rejects.toThrow('Seat is no longer available');
    expect(tx.eventSeat.updateMany).not.toHaveBeenCalled();
  });

  it('does not touch hold records when the seat was simply AVAILABLE', async () => {
    tx.$queryRaw.mockResolvedValue([seatRow({ status: 'AVAILABLE' })]);

    await holdSeat({ eventId: 'event-1', seatId: 'seat-1', userId: 'user-2' });

    expect(tx.seatHold.updateMany).not.toHaveBeenCalled();
    expect(tx.seatHold.create).toHaveBeenCalled();
  });
});
