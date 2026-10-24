import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiClient, extractErrorMessage } from '../api/client';
import { Booking, EventSummary, SeatView } from '../types';
import { categoryColor, eventImage, formatDate, formatTime, money, statusClass, tierKey, tierLabel } from '../ui';

// Decorative QR-style pattern seeded from the booking id (not a scannable code).
function QrPattern({ seed }: { seed: string }) {
  let h = 0;
  const cells = Array.from({ length: 121 }, (_, i) => {
    h = (h * 31 + seed.charCodeAt(i % seed.length) + i) >>> 0;
    const r = Math.floor(i / 11);
    const c = i % 11;
    const finder = (r < 3 && c < 3) || (r < 3 && c > 7) || (r > 7 && c < 3);
    return finder || h % 3 === 0;
  });
  return (
    <div className="qr" aria-hidden="true">
      {cells.map((on, i) => (
        <i key={i} className={on ? '' : 'off'} />
      ))}
    </div>
  );
}

export function BookingDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [event, setEvent] = useState<EventSummary | null>(null);
  const [seatInfo, setSeatInfo] = useState<Map<string, SeatView>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  async function load() {
    if (!id) return;
    try {
      const response = await apiClient.get(`/bookings/${id}`);
      const loaded: Booking = response.data.data;
      setBooking(loaded);
      // Booking items only carry seat ids; resolve them to section/row/number for display.
      const [eventRes, seatsRes] = await Promise.all([
        apiClient.get(`/events/${loaded.eventId}`),
        apiClient.get(`/events/${loaded.eventId}/seats`),
      ]);
      setEvent(eventRes.data.data);
      setSeatInfo(new Map((seatsRes.data.data as SeatView[]).map((s) => [s.seatId, s])));
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // A PENDING booking settles via Stripe's webhook / the worker; follow it live.
  useEffect(() => {
    if (booking?.status !== 'PENDING') return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking?.status]);

  async function cancel() {
    if (!id) return;
    setCancelling(true);
    setError(null);
    try {
      await apiClient.post(`/bookings/${id}/cancel`);
      setConfirmingCancel(false);
      await load();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setCancelling(false);
    }
  }

  if (error && !booking)
    return (
      <div className="page">
        <div className="empty">
          <h3>Couldn't load this booking</h3>
          <p>{error}</p>
          <Link to="/bookings" className="btn">
            Back to my tickets
          </Link>
        </div>
      </div>
    );
  if (!booking)
    return (
      <div className="page">
        <div className="skeleton" style={{ height: 380, maxWidth: 860, margin: '0 auto' }} />
      </div>
    );

  const confirmed = booking.status === 'CONFIRMED';
  const pending = booking.status === 'PENDING';
  const startsAt = event?.startsAt || booking.event?.startsAt;

  return (
    <div className="page">
      <div className="page-header" style={{ maxWidth: 860, margin: '0 auto 1.5rem' }}>
        <div>
          <p className="eyebrow">{confirmed ? "You're going!" : 'Booking'}</p>
          <h2>{confirmed ? 'Booking confirmed' : pending ? 'Awaiting payment' : `Booking ${booking.status.toLowerCase()}`}</h2>
          {pending && (
            <p className="hint">
              Your seats are held until the payment window closes
              {booking.expiresAt && ` (${formatTime(booking.expiresAt)})`}; unpaid seats are released automatically.
            </p>
          )}
        </div>
        <span className={statusClass(booking.status)}>{booking.status}</span>
      </div>

      {error && (
        <p className="alert alert-error" role="alert" style={{ maxWidth: 860, margin: '0 auto 1rem' }}>
          {error}
        </p>
      )}

      <article className={`ticket ${confirmed ? '' : 'ticket-cancelled'}`}>
        <div className="ticket-main">
          <div className="ticket-head" style={{ background: categoryColor(event?.category || '') }}>
            {event && <img src={eventImage(event)} alt="" className="art-img" />}
            <p className="eyebrow">
              {event?.category || 'Event'}
            </p>
            <h2 style={{ margin: 0 }}>{event?.name || booking.event?.name}</h2>
          </div>
          <div className="ticket-grid">
            {startsAt && (
              <>
                <div className="ticket-field">
                  <span>Date</span>
                  <strong>{formatDate(startsAt)}</strong>
                </div>
                <div className="ticket-field">
                  <span>Time</span>
                  <strong>{formatTime(startsAt)}</strong>
                </div>
              </>
            )}
            {event?.venue && (
              <div className="ticket-field">
                <span>Venue</span>
                <strong>
                  {event.venue.name}, {event.venue.city}
                </strong>
              </div>
            )}
            <div className="ticket-field">
              <span>Total paid</span>
              <strong>{money(booking.totalAmount)}</strong>
            </div>
          </div>
          <div className="ticket-field" style={{ marginBottom: '0.5rem' }}>
            <span>Seats ({booking.items.length})</span>
          </div>
          <div className="ticket-seats">
            {booking.items.map((item) => {
              const seat = seatInfo.get(item.seatId);
              return (
                <span key={item.id} className="ticket-seat">
                  {seat && <span className={`tier-dot tier-${tierKey(seat.seatType).toLowerCase()}`} />}
                  {seat
                    ? `${seat.section} · Row ${seat.row} · Seat ${seat.number}`
                    : seatInfo.size === 0
                      ? 'Loading seat…'
                      : `Seat ${item.seatId.slice(0, 8)}`}
                  {seat && <span className="hint">{tierLabel(seat.seatType)}</span>}
                  <strong>{money(item.price)}</strong>
                </span>
              );
            })}
          </div>
        </div>
        <div className="ticket-stub">
          <span className={`stamp ${confirmed ? '' : 'stamp-void'}`} aria-hidden="true">
            {confirmed ? 'Confirmed' : pending ? 'Pending' : 'Void'}
          </span>
          <QrPattern seed={booking.id} />
          <span className="mono">#{booking.id.slice(0, 8).toUpperCase()}</span>
          <span className="hint">{confirmed ? 'Show this at the entrance' : pending ? 'Valid once payment completes' : 'This ticket is no longer valid'}</span>
        </div>
      </article>

      <div className="ticket-actions">
        <Link to="/bookings" className="btn btn-ghost">
          ← My tickets
        </Link>
        {event && (
          <Link to={`/events/${event.id}`} className="btn btn-ghost">
            View event
          </Link>
        )}
        {(confirmed || pending) && !confirmingCancel && (
          <button className="btn-danger" onClick={() => setConfirmingCancel(true)}>
            Cancel booking
          </button>
        )}
        {(confirmed || pending) && confirmingCancel && (
          <>
            <button className="btn-danger" onClick={cancel} disabled={cancelling}>
              {cancelling ? 'Cancelling…' : pending ? 'Yes, release my seats' : 'Yes, cancel and refund'}
            </button>
            <button className="btn-ghost" onClick={() => setConfirmingCancel(false)} disabled={cancelling}>
              Keep it
            </button>
          </>
        )}
      </div>
    </div>
  );
}
