import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient, extractErrorMessage } from '../api/client';
import { Booking } from '../types';
import { formatDate, formatTime, money, statusClass } from '../ui';

export function MyBookingsPage() {
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .get('/bookings')
      .then((res) => setBookings(res.data.data))
      .catch((err) => setError(extractErrorMessage(err)));
  }, []);

  const now = Date.now();
  const stripe = (b: Booking) =>
    b.status === 'CONFIRMED' && b.event && new Date(b.event.startsAt).getTime() > now
      ? 'var(--accent)'
      : b.status === 'CONFIRMED'
        ? 'var(--text-dim)'
        : 'var(--danger)';

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Your wallet</p>
          <h2>My tickets</h2>
        </div>
        <Link to="/" className="btn btn-ghost btn-sm">
          Find more events
        </Link>
      </div>

      {error && <p className="alert alert-error">{error}</p>}

      <div className="booking-list">
        {bookings === null &&
          !error &&
          Array.from({ length: 3 }, (_, i) => <div key={i} className="skeleton" style={{ height: 76 }} aria-hidden="true" />)}
        {bookings?.map((b) => (
          <Link to={`/bookings/${b.id}`} className="booking-row" key={b.id}>
            <span className="stripe" style={{ background: stripe(b) }} />
            <div>
              <h3>{b.event?.name || 'Event'}</h3>
              <span className="muted">
                {b.event ? `${formatDate(b.event.startsAt)} · ${formatTime(b.event.startsAt)}` : formatDate(b.createdAt)}
              </span>
            </div>
            <span className="muted hide-sm">
              {b.items.length} seat{b.items.length === 1 ? '' : 's'}
            </span>
            <span className="amount hide-sm">{money(b.totalAmount)}</span>
            <span className={statusClass(b.status)}>{b.status}</span>
          </Link>
        ))}
      </div>

      {bookings?.length === 0 && (
        <div className="empty">
          <h3>No tickets yet</h3>
          <p>Your next great night out is one click away.</p>
          <Link to="/" className="btn">
            Browse events
          </Link>
        </div>
      )}
    </div>
  );
}
