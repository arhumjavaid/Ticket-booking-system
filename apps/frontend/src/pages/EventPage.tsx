import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { apiClient, extractErrorMessage } from '../api/client';
import { EventSummary, SeatView } from '../types';
import { SeatMap } from '../components/SeatMap';
import { useAuth } from '../context/AuthContext';

export function EventPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [event, setEvent] = useState<EventSummary | null>(null);
  const [seats, setSeats] = useState<SeatView[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [booking, setBooking] = useState(false);
  const idempotencyKeyRef = useRef<string>(crypto.randomUUID());

  const loadSeats = useCallback(async () => {
    if (!id) return;
    const response = await apiClient.get(`/events/${id}/seats`);
    setSeats(response.data.data);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    apiClient.get(`/events/${id}`).then((res) => setEvent(res.data.data));
    loadSeats();

    // Real-time availability (section 35): Server-Sent Events pushed from
    // the API instance that received this connection, fed by RabbitMQ
    // seat/booking events - so a hold/booking made via a DIFFERENT API
    // instance still shows up here within a second or two.
    const baseUrl = (apiClient.defaults.baseURL || '/api').replace(/\/$/, '');
    const source = new EventSource(`${baseUrl}/events/${id}/stream`);
    source.addEventListener('seat-update', () => loadSeats());
    source.onerror = () => {
      // Browser EventSource auto-reconnects; nothing to do here.
    };
    return () => source.close();
  }, [id, loadSeats]);

  async function toggleSeat(seat: SeatView) {
    if (!user) {
      navigate('/login');
      return;
    }
    setError(null);
    const isSelected = selected.has(seat.seatId);
    try {
      if (isSelected) {
        await apiClient.delete(`/events/${id}/seats/hold`, { data: { seatId: seat.seatId } });
        setSelected((prev) => {
          const next = new Set(prev);
          next.delete(seat.seatId);
          return next;
        });
      } else {
        await apiClient.post(`/events/${id}/seats/hold`, { seatId: seat.seatId });
        setSelected((prev) => new Set(prev).add(seat.seatId));
      }
      await loadSeats();
    } catch (err) {
      setError(extractErrorMessage(err));
      await loadSeats();
    }
  }

  async function confirmBooking() {
    if (selected.size === 0) return;
    setBooking(true);
    setError(null);
    try {
      const response = await apiClient.post(
        '/bookings',
        { eventId: id, seatIds: Array.from(selected) },
        { headers: { 'Idempotency-Key': idempotencyKeyRef.current } }
      );
      navigate(`/bookings/${response.data.data.id}`);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setBooking(false);
    }
  }

  if (!event) return <div className="page">Loading event...</div>;

  const selectedSeats = seats.filter((s) => selected.has(s.seatId));
  const total = selectedSeats.reduce((sum, s) => sum + Number(s.price), 0);

  return (
    <div className="page">
      <h2>{event.name}</h2>
      <p className="event-meta">
        {event.venue?.name}, {event.venue?.city} · {new Date(event.startsAt).toLocaleString()}
      </p>
      <p>{event.description}</p>

      {error && <p className="error-text">{error}</p>}

      <SeatMap seats={seats} selectedSeatIds={selected} onToggle={toggleSeat} />

      {selected.size > 0 && (
        <div className="booking-bar">
          <span>
            {selected.size} seat(s) selected - ${total.toFixed(2)}
          </span>
          <button onClick={confirmBooking} disabled={booking}>
            {booking ? 'Booking...' : 'Confirm Booking'}
          </button>
        </div>
      )}
    </div>
  );
}
