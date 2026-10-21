import { applySeatStatus, seatChange } from '../../apps/frontend/src/seatUpdates';
import type { SeatView } from '../../apps/frontend/src/types';

const seat = (seatId: string, status: SeatView['status'] = 'AVAILABLE') =>
  ({ seatId, status, eventSeatId: `es-${seatId}`, section: 'A', row: '1', number: 1, seatType: 'STANDARD', price: '10.00' }) as SeatView;

describe('Live seat-map updates', () => {
  it('maps each SSE routing key to the status it implies', () => {
    expect(seatChange({ routingKey: 'seat.held', data: { seatId: 's1' } })).toEqual({ status: 'HELD', seatIds: ['s1'] });
    expect(seatChange({ routingKey: 'seat.released', data: { seatId: 's1' } })).toEqual({ status: 'AVAILABLE', seatIds: ['s1'] });
    expect(seatChange({ routingKey: 'booking.confirmed', data: { seatIds: ['s1', 's2'] } })).toEqual({
      status: 'BOOKED',
      seatIds: ['s1', 's2'],
    });
    expect(seatChange({ routingKey: 'booking.cancelled', data: { seatIds: ['s1'] } })).toBeNull();
  });

  it('updates only the named seats and keeps the array when nothing changes', () => {
    const seats = [seat('s1'), seat('s2')];
    const next = applySeatStatus(seats, ['s2'], 'BOOKED');
    expect(next.map((s) => s.status)).toEqual(['AVAILABLE', 'BOOKED']);
    expect(next[0]).toBe(seats[0]);
    expect(applySeatStatus(next, ['s2'], 'BOOKED')).toBe(next);
  });
});
