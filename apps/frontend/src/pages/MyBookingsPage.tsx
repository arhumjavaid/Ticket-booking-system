import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../api/client';
import { Booking } from '../types';

export function MyBookingsPage() {
  const [bookings, setBookings] = useState<Booking[]>([]);

  useEffect(() => {
    apiClient.get('/bookings').then((res) => setBookings(res.data.data));
  }, []);

  return (
    <div className="page">
      <h2>My Bookings</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th>Event</th>
            <th>Status</th>
            <th>Total</th>
            <th>Seats</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {bookings.map((b) => (
            <tr key={b.id}>
              <td>{b.event?.name}</td>
              <td>{b.status}</td>
              <td>${b.totalAmount}</td>
              <td>{b.items.length}</td>
              <td>
                <Link to={`/bookings/${b.id}`}>View</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {bookings.length === 0 && <p>No bookings yet.</p>}
    </div>
  );
}
