import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient, extractErrorMessage } from '../api/client';
import { EventSummary } from '../types';

export function HomePage() {
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      if (query.trim()) {
        const response = await apiClient.get('/search/events', { params: { q: query, category: category || undefined } });
        setEvents(response.data.results.map((r: any) => ({ ...r, id: r.eventId, basePrice: String(r.basePrice) })));
      } else {
        const response = await apiClient.get('/events', { params: { category: category || undefined } });
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

  return (
    <div className="page">
      <h2>Upcoming Events</h2>
      <form
        className="search-bar"
        onSubmit={(e) => {
          e.preventDefault();
          load();
        }}
      >
        <input placeholder="Search events (powered by OpenSearch)..." value={query} onChange={(e) => setQuery(e.target.value)} />
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {['Concert', 'Theater', 'Sports', 'Comedy', 'Festival', 'Conference'].map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button type="submit">Search</button>
      </form>

      {loading && <p>Loading events...</p>}
      {error && <p className="error-text">{error}</p>}

      <div className="event-grid">
        {events.map((event) => (
          <Link to={`/events/${event.id}`} className="event-card" key={event.id}>
            <h3>{event.name}</h3>
            <p className="event-meta">
              {event.category} · {event.venue?.city || (event as any).city}
            </p>
            <p className="event-meta">{new Date(event.startsAt).toLocaleString()}</p>
            <p className="event-price">From ${event.basePrice}</p>
          </Link>
        ))}
        {!loading && events.length === 0 && <p>No events found.</p>}
      </div>
    </div>
  );
}
