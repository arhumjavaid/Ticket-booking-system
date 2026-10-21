import { useEffect, useState } from 'react';
import { apiClient, extractErrorMessage } from '../api/client';
import { EventSummary } from '../types';
import { money } from '../ui';

interface DashboardData {
  totalBookings: number;
  totalCancellations: number;
  totalRevenue: number;
  uniqueUsers: number;
  peakBookingHour: number | null;
  topEvents: { ticketEventId: string; bookings: number }[];
}

export function AnalyticsDashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [eventNames, setEventNames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .get('/analytics/dashboard')
      .then((res) => setData(res.data.data))
      .catch((err) => setError(extractErrorMessage(err)));
    // Analytics only stores event ids; look up names for the table (best effort).
    apiClient
      .get('/events', { params: { pageSize: 100 } })
      .then((res) => setEventNames(new Map((res.data.data as EventSummary[]).map((e) => [e.id, e.name]))))
      .catch(() => undefined);
  }, []);

  const maxBookings = data ? Math.max(1, ...data.topEvents.map((e) => e.bookings)) : 1;
  const stats = data
    ? [
        { label: 'Confirmed bookings', value: data.totalBookings.toLocaleString(), color: 'var(--success)' },
        { label: 'Revenue', value: money(data.totalRevenue.toFixed(2)), color: 'var(--accent)' },
        { label: 'Unique customers', value: data.uniqueUsers.toLocaleString(), color: 'var(--tier-premium)' },
        { label: 'Cancellations', value: data.totalCancellations.toLocaleString(), color: 'var(--danger)' },
        {
          label: 'Peak booking hour (UTC)',
          value: data.peakBookingHour === null ? '-' : `${String(data.peakBookingHour).padStart(2, '0')}:00`,
          color: 'var(--tier-vip)',
        },
      ]
    : [];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Admin</p>
          <h2>Analytics</h2>
          <p>
            Powered by ClickHouse (eventually consistent). Live Grafana dashboards: <code>http://localhost:3001</code>
          </p>
        </div>
      </div>
      {error && <p className="alert alert-error">{error}</p>}
      <div className="stat-grid">
        {!data &&
          !error &&
          Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton" style={{ height: 104 }} aria-hidden="true" />)}
        {stats.map((s) => (
          <div key={s.label} className="stat-card" style={{ ['--stat-color' as string]: s.color }}>
            <span className="stat-value">{s.value}</span>
            <span className="stat-label">{s.label}</span>
          </div>
        ))}
      </div>
      {data && (
        <section>
          <div className="section-head">
            <h3>Top events by bookings</h3>
          </div>
          {data.topEvents.length === 0 ? (
            <div className="empty">
              <p>No bookings recorded yet.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Bookings</th>
                    <th style={{ width: '40%' }}>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topEvents.map((e) => (
                    <tr key={e.ticketEventId}>
                      <td>{eventNames.get(e.ticketEventId) || <span className="mono">{e.ticketEventId.slice(0, 8)}</span>}</td>
                      <td>{e.bookings}</td>
                      <td>
                        <div className="bar-track">
                          <div className="bar-fill" style={{ width: `${(e.bookings / maxBookings) * 100}%` }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
