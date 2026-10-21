import { FormEvent, useEffect, useRef, useState } from 'react';
import { apiClient, extractErrorMessage } from '../api/client';
import { EventSummary, Venue } from '../types';
import { CATEGORIES, TIERS, eventImage, formatDate, money, statusClass } from '../ui';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const IMAGE_MAX_WIDTH = 1600;

// Downscale in the browser so uploads stay well under the API's 2 MB limit.
async function prepareImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_MAX_WIDTH / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; // flatten PNG transparency for JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not process image'))), 'image/jpeg', 0.85)
  );
}

// Mirrors SEAT_TIER_MULTIPLIERS on the API; only used for placeholder hints.
const TIER_MULTIPLIERS: Record<string, number> = { VIP: 2, PREMIUM: 1.5, REGULAR: 1 };

export function AdminDashboardPage() {
  const [venues, setVenues] = useState<Venue[]>([]);
  const [bookings, setBookings] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [eventForm, setEventForm] = useState({
    venueId: '',
    name: '',
    description: '',
    category: 'Concert',
    startsAt: '',
    endsAt: '',
    basePrice: 50,
  });
  // Blank = API default (base price x tier multiplier).
  const [image, setImage] = useState<Blob | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [tierPrices, setTierPrices] = useState<Record<string, string>>({ VIP: '', PREMIUM: '', REGULAR: '' });

  // Existing events + per-row image actions.
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [imageBusyId, setImageBusyId] = useState<string | null>(null);
  const [imageNotice, setImageNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const changeInputRef = useRef<HTMLInputElement>(null);
  const changeTargetRef = useRef<string | null>(null);

  function loadEvents() {
    apiClient.get('/events', { params: { pageSize: 100 } }).then((res) => setEvents(res.data.data));
  }

  function setEventImage(id: string, imageUpdatedAt: string | null) {
    setEvents((prev) => prev.map((e) => (e.id === id ? { ...e, imageUpdatedAt } : e)));
  }

  async function onChangeImageFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const id = changeTargetRef.current;
    e.target.value = '';
    if (!file || !id) return;
    setImageNotice(null);
    if (!IMAGE_TYPES.includes(file.type)) {
      setImageNotice({ ok: false, text: 'Please choose a JPEG, PNG or WebP image.' });
      return;
    }
    setImageBusyId(id);
    try {
      const blob = await prepareImage(file);
      const res = await apiClient.put(`/events/${id}/image`, blob, { headers: { 'Content-Type': 'image/jpeg' } });
      setEventImage(id, res.data.data.imageUpdatedAt);
      setImageNotice({ ok: true, text: 'Image updated.' });
    } catch (err) {
      setImageNotice({ ok: false, text: `Image upload failed: ${extractErrorMessage(err)}` });
    } finally {
      setImageBusyId(null);
    }
  }

  async function restoreDefaultImage(id: string) {
    setImageNotice(null);
    setImageBusyId(id);
    try {
      await apiClient.delete(`/events/${id}/image`);
      setEventImage(id, null);
      setImageNotice({ ok: true, text: 'Switched back to the default image.' });
    } catch (err) {
      setImageNotice({ ok: false, text: `Could not remove image: ${extractErrorMessage(err)}` });
    } finally {
      setImageBusyId(null);
    }
  }

  useEffect(() => {
    loadEvents();
    apiClient.get('/venues').then((res) => setVenues(res.data.data));
    apiClient.get('/bookings', { params: { all: 'true', pageSize: 50 } }).then((res) => setBookings(res.data.data));
    apiClient.get('/admin/users').then((res) => setUsers(res.data.data));
  }, []);

  async function createEvent(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setSubmitting(true);
    try {
      const created = await apiClient.post('/events', {
        ...eventForm,
        basePrice: Number(eventForm.basePrice),
        startsAt: new Date(eventForm.startsAt).toISOString(),
        endsAt: new Date(eventForm.endsAt).toISOString(),
        tags: [],
        tierPrices: Object.fromEntries(
          Object.entries(tierPrices)
            .filter(([, v]) => v !== '')
            .map(([k, v]) => [k, Number(v)])
        ),
      });
      if (image) {
        try {
          await apiClient.put(`/events/${created.data.data.id}/image`, image, { headers: { 'Content-Type': 'image/jpeg' } });
        } catch (err) {
          setMessage('Event created and published.');
          setError(`Image upload failed: ${extractErrorMessage(err)}`);
          return;
        }
      }
      setMessage('Event created and published.');
      loadEvents();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  function setPickedImage(blob: Blob | null, preview: string | null) {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImage(blob);
    setImagePreview(preview);
  }

  async function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    setError(null);
    if (!IMAGE_TYPES.includes(file.type)) {
      setError('Please choose a JPEG, PNG or WebP image.');
      return;
    }
    try {
      const blob = await prepareImage(file);
      setPickedImage(blob, URL.createObjectURL(blob));
    } catch {
      setError('That image could not be read. Try a different file.');
    }
  }

  const userEmail = new Map(users.map((u) => [u.id, u.email]));

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Admin</p>
          <h2>Dashboard</h2>
        </div>
      </div>

      <section className="card">
        <div className="section-head">
          <h3>Create event</h3>
        </div>
        <form className="form-grid" onSubmit={createEvent}>
          <label>
            Name
            <input value={eventForm.name} onChange={(e) => setEventForm({ ...eventForm, name: e.target.value })} required />
          </label>
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
            Category
            <select value={eventForm.category} onChange={(e) => setEventForm({ ...eventForm, category: e.target.value })} required>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label>
            Base price (USD)
            <input
              type="number"
              min={1}
              step="0.01"
              value={eventForm.basePrice}
              onChange={(e) => setEventForm({ ...eventForm, basePrice: Number(e.target.value) })}
              required
            />
          </label>
          <label>
            Starts at
            <input type="datetime-local" value={eventForm.startsAt} onChange={(e) => setEventForm({ ...eventForm, startsAt: e.target.value })} required />
          </label>
          <label>
            Ends at
            <input
              type="datetime-local"
              min={eventForm.startsAt || undefined}
              value={eventForm.endsAt}
              onChange={(e) => setEventForm({ ...eventForm, endsAt: e.target.value })}
              required
            />
          </label>
          <div className="full">
            <label htmlFor="event-image">Event image (optional - JPEG, PNG or WebP)</label>
            <div className="image-picker" style={{ marginTop: '0.4rem' }}>
              <img
                className="image-preview"
                src={imagePreview || eventImage({ id: '', category: eventForm.category })}
                alt={imagePreview ? 'Selected event image' : `Default ${eventForm.category} image`}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <input id="event-image" type="file" accept={IMAGE_TYPES.join(',')} onChange={onPickImage} />
                <span className="hint">{imagePreview ? 'Will be uploaded with the event.' : `No image? We'll use the ${eventForm.category} default shown here.`}</span>
                {imagePreview && (
                  <button type="button" className="btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setPickedImage(null, null)}>
                    Remove image
                  </button>
                )}
              </div>
            </div>
          </div>
          <fieldset className="full tier-fieldset">
            <legend>Seat tier prices (optional - leave blank to use base price × multiplier)</legend>
            <div className="tier-inputs">
              {TIERS.map((t) => (
                <label key={t.key} className={`tier-${t.key.toLowerCase()}`}>
                  <span className="tier-name">
                    <span className="tier-dot" /> {t.label} <span className="hint">×{TIER_MULTIPLIERS[t.key]}</span>
                  </span>
                  <input
                    type="number"
                    min={1}
                    step="0.01"
                    placeholder={money(Number(eventForm.basePrice || 0) * TIER_MULTIPLIERS[t.key])}
                    value={tierPrices[t.key]}
                    onChange={(e) => setTierPrices({ ...tierPrices, [t.key]: e.target.value })}
                  />
                </label>
              ))}
            </div>
          </fieldset>
          <label className="full">
            Description
            <textarea value={eventForm.description} onChange={(e) => setEventForm({ ...eventForm, description: e.target.value })} required />
          </label>
          {message && <p className="alert alert-success full">{message}</p>}
          {error && <p className="alert alert-error full">{error}</p>}
          <div className="form-actions">
            <button type="submit" disabled={submitting}>
              {submitting ? 'Publishing…' : 'Create & publish event'}
            </button>
          </div>
        </form>
      </section>

      <section>
        <div className="section-head">
          <h3>Events</h3>
          <span className="count">{events.length} published</span>
        </div>
        {imageNotice && (
          <p className={`alert ${imageNotice.ok ? 'alert-success' : 'alert-error'}`} role="status">
            {imageNotice.text}
          </p>
        )}
        <input ref={changeInputRef} type="file" accept={IMAGE_TYPES.join(',')} hidden onChange={onChangeImageFile} />
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Image</th>
                <th>Event</th>
                <th>Date</th>
                <th>Category</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id}>
                  <td>
                    <img className="event-thumb" src={eventImage(ev)} alt="" />
                  </td>
                  <td>
                    <strong>{ev.name}</strong>
                    <div className="hint">{ev.imageUpdatedAt ? 'Custom image' : 'Default image'}</div>
                  </td>
                  <td>{formatDate(ev.startsAt)}</td>
                  <td>{ev.category}</td>
                  <td>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button
                        type="button"
                        className="btn-ghost btn-sm"
                        disabled={imageBusyId !== null}
                        onClick={() => {
                          changeTargetRef.current = ev.id;
                          changeInputRef.current?.click();
                        }}
                      >
                        {imageBusyId === ev.id ? 'Saving…' : 'Change image'}
                      </button>
                      {ev.imageUpdatedAt && (
                        <button type="button" className="btn-danger btn-sm" disabled={imageBusyId !== null} onClick={() => restoreDefaultImage(ev.id)}>
                          Use default
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {events.length === 0 && (
                <tr>
                  <td colSpan={5} className="hint">
                    No events yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="section-head">
          <h3>All bookings</h3>
          <span className="count">{bookings.length} shown</span>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Booking</th>
                <th>Customer</th>
                <th>Event</th>
                <th>Status</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {bookings.map((b) => (
                <tr key={b.id}>
                  <td className="mono">#{b.id.slice(0, 8).toUpperCase()}</td>
                  <td>{userEmail.get(b.userId) || <span className="mono">{b.userId.slice(0, 8)}</span>}</td>
                  <td>{b.event?.name}</td>
                  <td>
                    <span className={statusClass(b.status)}>{b.status}</span>
                  </td>
                  <td>{money(b.totalAmount)}</td>
                </tr>
              ))}
              {bookings.length === 0 && (
                <tr>
                  <td colSpan={5} className="hint">
                    No bookings yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="section-head">
          <h3>Users</h3>
          <span className="count">{users.length} total</span>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td>{u.email}</td>
                  <td>
                    <span className={u.role === 'ADMIN' ? 'badge badge-admin' : 'badge'}>{u.role}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
