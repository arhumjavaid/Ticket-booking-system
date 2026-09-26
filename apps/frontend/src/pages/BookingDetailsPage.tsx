import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiClient, extractErrorMessage } from '../api/client';
import { Booking } from '../types';

export function BookingDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  async function load() {
    if (!id) return;
    try {
      const response = await apiClient.get(`/bookings/${id}`);
      setBooking(response.data.data);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function cancel() {
    if (!id) return;
    setCancelling(true);
    try {
      await apiClient.post(`/bookings/${id}/cancel`);
      await load();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setCancelling(false);
    }
  }

  if (error) return <div className="page error-text">{error}</div>;
  if (!booking) return <div className="page">Loading booking...</div>;

  return (
    <div className="page">
      <h2>Booking {booking.status === 'CONFIRMED' ? 'Confirmed' : booking.status}</h2>
      <p>Booking ID: {booking.id}</p>
      <p>Event: {booking.event?.name}</p>
      <p>Total: ${booking.totalAmount}</p>
      <h4>Seats</h4>
      <ul>
        {booking.items.map((item) => (
          <li key={item.id}>
            Seat {item.seatId} - ${item.price}
          </li>
        ))}
      </ul>
      {booking.status === 'CONFIRMED' && (
        <button onClick={cancel} disabled={cancelling}>
          {cancelling ? 'Cancelling...' : 'Cancel Booking'}
        </button>
      )}
      <p>
        <Link to="/bookings">Back to My Bookings</Link>
      </p>
    </div>
  );
}
