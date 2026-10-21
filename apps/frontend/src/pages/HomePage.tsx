import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient, extractErrorMessage } from '../api/client';
import { EventSummary } from '../types';
import { CATEGORIES, categoryColor, eventImage, dateBadge, formatDate, formatTime, money } from '../ui';

function cityOf(event: EventSummary): string | undefined {
  return event.venue?.city || (event as any).city;
}

const SCARCE_SEATS = 20;

function scarce(event: EventSummary): boolean {
  return event.availableSeats !== undefined && event.availableSeats <= SCARCE_SEATS;
}

function scarcityLabel(available: number): string {
  return available === 0 ? 'Sold out' : `Only ${available} left`;
}

export function HomePage() {
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(nextCategory = category) {
    setLoading(true);
    setError(null);
    try {
      if (query.trim()) {
        const response = await apiClient.get('/search/events', { params: { q: query, category: nextCategory || undefined } });
        setEvents(response.data.results.map((r: any) => ({ ...r, id: r.eventId, basePrice: String(r.basePrice) })));
      } else {
        const response = await apiClient.get('/events', { params: { category: nextCategory || undefined } });
        setEvents(response.data.data);
      }
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pickCategory(next: string) {
    setCategory(next);
    load(next);
  }

  const now = Date.now();
  const featured = !query && !category ? events.find((e) => new Date(e.startsAt).getTime() > now) : undefined;
  const gridEvents = featured ? events.filter((e) => e.id !== featured.id) : events;

  return (
    <div className="page">
      <header className="hero">
        <span className="hero-sticker" aria-hidden="true">
          Pick
          <br />
          your
          <br />
          seat!
        </span>
        <p className="eyebrow">Live events · Real seats · Instant booking</p>
        <h1>
          Your next <span className="marker">unforgettable</span> night starts here
        </h1>
        <p>Concerts, sports, theater and more. Pick your exact seat - VIP, Premium or Regular - and lock it in seconds.</p>
        <form
          className="search-bar"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            load();
          }}
        >
          <input
            aria-label="Search events"
            placeholder="Search artists, teams, shows..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit">Search</button>
        </form>
      </header>

      <div className="ticker" aria-hidden="true">
        <div className="ticker-track">
          {[0, 1].map((copy) => (
            <span key={copy}>
              {events.map((e) => (
                <span key={e.id} className="ticker-item">
                  ★ {e.name}
                </span>
              ))}
              <span className="ticker-item">★ VIP · Premium · Regular seats</span>
              <span className="ticker-item">★ No hidden fees</span>
            </span>
          ))}
        </div>
      </div>

      {featured && (
        <Link to={`/events/${featured.id}`} className="featured">
          <div className="featured-art" style={{ background: categoryColor(featured.category) }}>
            <img src={eventImage(featured)} alt="" className="art-img" />
            <span className="badge badge-hot">{scarce(featured) ? scarcityLabel(featured.availableSeats!) : 'Featured'}</span>
          </div>
          <div className="featured-body">
            <p className="eyebrow">{featured.category}</p>
            <h2>{featured.name}</h2>
            <p>{featured.description}</p>
            <p className="event-meta">
              {formatDate(featured.startsAt)} · {formatTime(featured.startsAt)}
              {cityOf(featured) && ` · ${featured.venue?.name ? `${featured.venue.name}, ` : ''}${cityOf(featured)}`}
            </p>
            <div className="event-foot">
              <span className="event-price">
                <small>from</small>
                {money(featured.basePrice)}
              </span>
              <span className="btn btn-sm">Get tickets →</span>
            </div>
          </div>
        </Link>
      )}

      <div className="toolbar">
        <h2 style={{ margin: 0 }}>{query ? `Results for “${query}”` : 'Upcoming events'}</h2>
        <div className="chips" role="group" aria-label="Filter by category">
          <button type="button" className={`chip ${category === '' ? 'active' : ''}`} onClick={() => pickCategory('')}>
            All
          </button>
          {CATEGORIES.map((c) => (
            <button type="button" key={c} className={`chip ${category === c ? 'active' : ''}`} onClick={() => pickCategory(c)}>
              {c}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="alert alert-error">{error}</p>}

      <div className="event-grid">
        {loading &&
          Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton skeleton-card" aria-hidden="true" />)}
        {!loading &&
          gridEvents.map((event, index) => {
            const badge = dateBadge(event.startsAt);
            const past = new Date(event.startsAt).getTime() < now;
            return (
              <Link
                to={`/events/${event.id}`}
                className="event-card"
                key={event.id}
                style={{ ['--i' as string]: index }}
              >
                <div className="event-art" style={{ background: categoryColor(event.category) }}>
                  <img src={eventImage(event)} alt="" className="art-img" loading="lazy" />
                  <div className="date-badge">
                    <span className="m">{badge.month}</span>
                    <span className="d">{badge.day}</span>
                  </div>
                  <span className={scarce(event) ? 'badge badge-hot' : 'badge'}>
                    {past ? 'Past event' : scarce(event) ? scarcityLabel(event.availableSeats!) : event.category}
                  </span>
                </div>
                <div className="event-body">
                  <h3>{event.name}</h3>
                  <p className="event-meta">
                    {formatTime(event.startsAt)}
                    {cityOf(event) && ` · ${cityOf(event)}`}
                  </p>
                  <div className="event-foot">
                    <span className="event-price">
                      <small>from</small>
                      {money(event.basePrice)}
                    </span>
                    <span className="event-cta">Select seats →</span>
                  </div>
                </div>
              </Link>
            );
          })}
      </div>
      {!loading && !error && events.length === 0 && (
        <div className="empty">
          <h3>No events found</h3>
          <p>Try a different search or category.</p>
        </div>
      )}
    </div>
  );
}
