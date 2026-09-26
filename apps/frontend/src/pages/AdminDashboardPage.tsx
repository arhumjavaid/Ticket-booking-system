import { FormEvent, useEffect, useState } from 'react';
import { apiClient, extractErrorMessage } from '../api/client';
import { Venue } from '../types';

export function AdminDashboardPage() {
  const [venues, setVenues] = useState<Venue[]>([]);
  const [bookings, setBookings] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [eventForm, setEventForm] = useState({
    venueId: '',
    name: '',
    description: '',
    category: 'Concert',
    startsAt: '',
    endsAt: '',
    basePrice: 50,
  });

  useEffect(() => {
    apiClient.get('/venues').then((res) => setVenues(res.data.data));
    apiClient.get('/bookings', { params: { all: 'true', pageSize: 50 } }).then((res) => setBookings(res.data.data));
    apiClient.get('/admin/users').then((res) => setUsers(res.data.data));
  }, []);

  async function createEvent(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await apiClient.post('/events', {
        ...eventForm,
        basePrice: Number(eventForm.basePrice),
        startsAt: new Date(eventForm.startsAt).toISOString(),
        endsAt: new Date(eventForm.endsAt).toISOString(),
        tags: [],
      });
      setMessage('Event created and published.');
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <div className="page">
      <h2>Admin Dashboard</h2>

      <section>
        <h3>Create Event</h3>
        <form className="form-grid" onSubmit={createEvent}>
          <label>
            Venue
            <select value={eventForm.venueId} onChange={(e) => setEventForm({ ...eventForm, venueId: e.target.value })} required>
              <option value="">Select venue</option>
              {venues.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.city})
                </option>
              ))}
            </select>
          </label>
          <label>
            Name
            <input value={eventForm.name} onChange={(e) => setEventForm({ ...eventForm, name: e.target.value })} required />
          </label>
          <label>
            Description
            <input value={eventForm.description} onChange={(e) => setEventForm({ ...eventForm, description: e.target.value })} required />
          </label>
          <label>
            Category
            <input value={eventForm.category} onChange={(e) => setEventForm({ ...eventForm, category: e.target.value })} required />
          </label>
          <label>
            Starts At
            <input type="datetime-local" value={eventForm.startsAt} onChange={(e) => setEventForm({ ...eventForm, startsAt: e.target.value })} required />
          </label>
          <label>
            Ends At
            <input type="datetime-local" value={eventForm.endsAt} onChange={(e) => setEventForm({ ...eventForm, endsAt: e.target.value })} required />
          </label>
          <label>
            Base Price
            <input type="number" value={eventForm.basePrice} onChange={(e) => setEventForm({ ...eventForm, basePrice: Number(e.target.value) })} required />
          </label>
          <button type="submit">Create Event</button>
        </form>
        {message && <p className="success-text">{message}</p>}
        {error && <p className="error-text">{error}</p>}
      </section>

      <section>
        <h3>All Bookings</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>User</th>
              <th>Event</th>
              <th>Status</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {bookings.map((b) => (
              <tr key={b.id}>
                <td>{b.id.slice(0, 8)}</td>
                <td>{b.userId.slice(0, 8)}</td>
                <td>{b.event?.name}</td>
                <td>{b.status}</td>
                <td>${b.totalAmount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h3>Users</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Role</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>{u.name}</td>
                <td>{u.role}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
