import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { apiClient, extractErrorMessage } from '../api/client';
import { EventSummary, SeatView } from '../types';
import { SeatMap } from '../components/SeatMap';
import { applySeatStatus, seatChange } from '../seatUpdates';
import { useAuth } from '../context/AuthContext';
import { TIERS, categoryColor, eventImage, formatDate, formatTime, money, tierKey, tierLabel } from '../ui';

// Matches SEAT_HOLD_TTL_SECONDS default; only used if the hold response lacks expiresAt.
const SEAT_HOLD_FALLBACK_MS = 5 * 60 * 1000;

export function EventPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [event, setEvent] = useState<EventSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [seats, setSeats] = useState<SeatView[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // seatId -> hold expiry (ms epoch), used for the checkout countdown.
  const [holdExpiry, setHoldExpiry] = useState<Map<string, number>>(new Map());
  const [activeTier, setActiveTier] = useState<string | null>(null);
  const [pendingSeatId, setPendingSeatId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [booking, setBooking] = useState(false);
  const idempotencyKeyRef = useRef<string>(crypto.randomUUID());

  const loadSeats = useCallback(async () => {
    if (!id) return;
    const response = await apiClient.get(`/events/${id}/seats`);
    setSeats(response.data.data);
  }, [id]);

  const setSeatStatus = useCallback((seatIds: string[], status: SeatView['status']) => {
    setSeats((prev) => applySeatStatus(prev, seatIds, status));
  }, []);

  const dropSelection = useCallback((seatIds: string[]) => {
    setSelected((prev) => {
      if (!seatIds.some((seatId) => prev.has(seatId))) return prev;
      const next = new Set(prev);
      seatIds.forEach((seatId) => next.delete(seatId));
      return next;
    });
    setHoldExpiry((prev) => {
      const next = new Map(prev);
      seatIds.forEach((seatId) => next.delete(seatId));
      return next;
    });
  }, []);

  useEffect(() => {
    if (!id) return;
    apiClient
      .get(`/events/${id}`)
      .then((res) => setEvent(res.data.data))
      .catch((err) => setLoadError(extractErrorMessage(err)));
    loadSeats().catch((err) => setError(extractErrorMessage(err)));

    // Real-time availability (section 35): Server-Sent Events pushed from
    // the API instance that received this connection, fed by RabbitMQ
    // seat/booking events - so a hold/booking made via a DIFFERENT API
    // instance still shows up here within a second or two.
    const baseUrl = (apiClient.defaults.baseURL || '/api').replace(/\/$/, '');
    // Each update is applied to local state rather than triggering a full
    // reload. Updates missed while disconnected are recovered by one reload
    // when the (auto-reconnecting) stream comes back.
    const source = new EventSource(`${baseUrl}/events/${id}/stream`);
    let connectedBefore = false;
    source.addEventListener('connected', () => {
      if (connectedBefore) loadSeats();
      connectedBefore = true;
    });
    source.addEventListener('seat-update', (message) => {
      const change = seatChange(JSON.parse((message as MessageEvent).data));
      if (!change) return;
      setSeatStatus(change.seatIds, change.status);
      // One of our own holds was released (e.g. it expired): it is no
      // longer ours to book.
      if (change.status === 'AVAILABLE') dropSelection(change.seatIds);
    });
    return () => source.close();
  }, [id, loadSeats, setSeatStatus, dropSelection]);

  // Tick the countdown only while something is held.
  useEffect(() => {
    if (selected.size === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [selected.size]);

  const expiries = Array.from(selected, (seatId) => holdExpiry.get(seatId)).filter((v): v is number => v !== undefined);
  const holdEndsAt = expiries.length ? Math.min(...expiries) : null;
  const secondsLeft = holdEndsAt === null ? null : Math.max(0, Math.round((holdEndsAt - now) / 1000));

  // Hold ran out locally: the server releases it too, so stop offering it.
  useEffect(() => {
    if (secondsLeft !== 0) return;
    const expired = Array.from(selected).filter((seatId) => (holdExpiry.get(seatId) ?? Infinity) <= now);
    if (expired.length === 0) return;
    dropSelection(expired);
    setError('Your seat hold expired. Please pick your seats again.');
    loadSeats();
  }, [secondsLeft, selected, holdExpiry, now, dropSelection, loadSeats]);

  async function toggleSeat(seat: SeatView) {
    if (!user) {
      navigate('/login', { state: { from: `/events/${id}` } });
      return;
    }
    setError(null);
    setPendingSeatId(seat.seatId);
    const isSelected = selected.has(seat.seatId);
    try {
      if (isSelected) {
        await apiClient.delete(`/events/${id}/seats/hold`, { data: { seatId: seat.seatId } });
        dropSelection([seat.seatId]);
        setSeatStatus([seat.seatId], 'AVAILABLE');
      } else {
        const response = await apiClient.post(`/events/${id}/seats/hold`, { seatId: seat.seatId });
        const expiresAt = response.data?.data?.expiresAt ?? response.data?.expiresAt;
        const expiry = expiresAt ? new Date(expiresAt).getTime() : Date.now() + SEAT_HOLD_FALLBACK_MS;
        setSelected((prev) => new Set(prev).add(seat.seatId));
        setHoldExpiry((prev) => new Map(prev).set(seat.seatId, expiry));
        setSeatStatus([seat.seatId], 'HELD');
        setNow(Date.now());
      }
    } catch (err) {
      setError(extractErrorMessage(err));
      await loadSeats();
    } finally {
      setPendingSeatId(null);
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

  if (loadError)
    return (
      <div className="page">
        <div className="empty">
          <h3>Event not available</h3>
          <p>{loadError}</p>
          <Link to="/" className="btn">
            Browse events
          </Link>
        </div>
      </div>
    );
  if (!event)
    return (
      <div className="page">
        <div className="skeleton" style={{ height: 260, marginBottom: 24 }} />
        <div className="skeleton" style={{ height: 420 }} />
      </div>
    );

  const selectedSeats = seats.filter((s) => selected.has(s.seatId));
  const total = selectedSeats.reduce((sum, s) => sum + Number(s.price), 0);
  const tiers = TIERS.map((t) => {
    const tierSeats = seats.filter((s) => tierKey(s.seatType) === t.key);
    const availableSeats = tierSeats.filter((s) => s.status === 'AVAILABLE');
    // Price what can actually be bought; sold seats may carry an older price.
    const priced = availableSeats.length ? availableSeats : tierSeats;
    return {
      ...t,
      count: tierSeats.length,
      available: availableSeats.length,
      minPrice: priced.length ? Math.min(...priced.map((s) => Number(s.price))) : 0,
    };
  }).filter((t) => t.count > 0);
  const totalAvailable = seats.filter((s) => s.status === 'AVAILABLE').length;
  const timerText =
    secondsLeft === null ? null : `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;
  const isPast = new Date(event.startsAt).getTime() < Date.now();

  const confirmButton = (
    <button className="btn-block" onClick={confirmBooking} disabled={booking || selected.size === 0}>
      {booking ? 'Booking…' : selected.size ? `Book ${selected.size} seat${selected.size > 1 ? 's' : ''} · ${money(total)}` : 'Select seats'}
    </button>
  );

  return (
    <div className={`page ${selected.size > 0 ? 'has-mobile-bar' : ''}`}>
      <Link to="/" className="back-link">
        ← All events
      </Link>
      <header className="event-hero" style={{ background: categoryColor(event.category) }}>
        <img src={eventImage(event)} alt={`${event.name} artwork`} className="event-hero-img" />
        <p className="eyebrow">
          {event.category}
          {isPast && ' · Past event'}
        </p>
        <h1>{event.name}</h1>
        <div className="info-pills">
          <span className="info-pill">{formatDate(event.startsAt)}</span>
          <span className="info-pill">{formatTime(event.startsAt)}</span>
          {event.venue && (
            <span className="info-pill">
              {event.venue.name}, {event.venue.city}
            </span>
          )}
          <span className="info-pill">{totalAvailable} seats left</span>
        </div>
        <p className="desc">{event.description}</p>
      </header>

      <div className="booking-layout">
        <div>
          <div className="section-head">
            <h3>Choose your tier</h3>
            {activeTier && (
              <button className="btn-ghost btn-sm" onClick={() => setActiveTier(null)}>
                Show all
              </button>
            )}
          </div>
          <div className="tier-filters" role="group" aria-label="Filter seats by tier">
            {tiers.map((t) => (
              <button
                key={t.key}
                type="button"
                aria-pressed={activeTier === t.key}
                className={`tier-card tier-${t.key.toLowerCase()} ${activeTier === t.key ? 'active' : ''}`}
                onClick={() => setActiveTier(activeTier === t.key ? null : t.key)}
              >
                <span className="tier-name">
                  <span className="tier-dot" /> {t.label}
                </span>
                <span className="tier-price">{money(t.minPrice)}</span>
                <span className="tier-left">
                  {t.available === 0 ? 'Sold out' : t.available <= 10 ? `Only ${t.available} left!` : `${t.available} available`}
                </span>
              </button>
            ))}
          </div>

          {error && (
            <p className="alert alert-error" role="alert">
              {error}
            </p>
          )}

          <SeatMap
            seats={seats}
            selectedSeatIds={selected}
            onToggle={toggleSeat}
            activeTier={activeTier}
            pendingSeatId={pendingSeatId}
          />
        </div>

        <aside className="summary card" aria-label="Your selection">
          <h3>Your tickets</h3>
          {!user && (
            <p className="hint">
              <Link to="/login" state={{ from: `/events/${id}` }}>
                Log in
              </Link>{' '}
              to pick and hold seats.
            </p>
          )}
          {user && selected.size === 0 && <p className="hint">Tap any available seat on the map to hold it for checkout.</p>}
          {timerText && (
            <div className={`timer ${secondsLeft! <= 60 ? 'urgent' : ''}`} role="timer" aria-live="off">
              Seats held for <strong>{timerText}</strong>
            </div>
          )}
          {selectedSeats.length > 0 && (
            <ul className="summary-list">
              {selectedSeats.map((s) => (
                <li key={s.seatId} className="summary-item">
                  <span className="seat-label">
                    <span className={`tier-dot tier-${tierKey(s.seatType).toLowerCase()}`} />
                    <span>
                      {s.section} · {s.row}
                      {s.number}
                      <br />
                      <span className="hint">{tierLabel(s.seatType)}</span>
                    </span>
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <strong>{money(s.price)}</strong>
                    <button
                      className="remove"
                      aria-label={`Remove ${s.section} ${s.row}${s.number}`}
                      disabled={pendingSeatId === s.seatId}
                      onClick={() => toggleSeat(s)}
                    >
                      ×
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="summary-total">
            <span className="hint">Total</span>
            <strong>{money(total)}</strong>
          </div>
          {confirmButton}
          <p className="hint" style={{ margin: 0 }}>
            No hidden fees - the price you see is the price you pay.
          </p>
        </aside>
      </div>

      {selected.size > 0 && (
        <div className="mobile-bar">
          <div>
            <strong>{money(total)}</strong>
            <div className="hint">
              {selected.size} seat{selected.size > 1 ? 's' : ''}
              {timerText && ` · ${timerText} left`}
            </div>
          </div>
          <button onClick={confirmBooking} disabled={booking}>
            {booking ? 'Booking…' : 'Book now'}
          </button>
        </div>
      )}
    </div>
  );
}
