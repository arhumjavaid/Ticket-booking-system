import { useEffect, useState } from 'react';
import { apiClient, extractErrorMessage } from '../api/client';

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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .get('/analytics/dashboard')
      .then((res) => setData(res.data.data))
      .catch((err) => setError(extractErrorMessage(err)));
  }, []);

  return (
    <div className="page">
      <h2>Analytics Dashboard</h2>
      <p className="hint">
        Powered by ClickHouse (async, eventually consistent). Live Prometheus/Grafana dashboards are available at{' '}
        <code>http://localhost:3001</code>.
      </p>
      {error && <p className="error-text">{error}</p>}
      {data && (
        <div className="stat-grid">
          <div className="stat-card">
            <span className="stat-value">{data.totalBookings}</span>
            <span className="stat-label">Confirmed Bookings</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{data.totalCancellations}</span>
            <span className="stat-label">Cancellations</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">${data.totalRevenue.toFixed(2)}</span>
            <span className="stat-label">Revenue</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{data.uniqueUsers}</span>
            <span className="stat-label">Unique Users</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{data.peakBookingHour ?? '-'}</span>
            <span className="stat-label">Peak Booking Hour (UTC)</span>
          </div>
        </div>
      )}
      {data && data.topEvents.length > 0 && (
        <>
          <h3>Top Events by Bookings</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>Event ID</th>
                <th>Bookings</th>
              </tr>
            </thead>
            <tbody>
              {data.topEvents.map((e) => (
                <tr key={e.ticketEventId}>
                  <td>{e.ticketEventId}</td>
                  <td>{e.bookings}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
