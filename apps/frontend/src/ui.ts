// Small presentation helpers shared by pages: seat tiers, dates, money, category colors.

export interface Tier {
  key: string;
  label: string;
}

// Order = display order (most expensive first). Unknown seat types fall back to REGULAR styling.
export const TIERS: Tier[] = [
  { key: 'VIP', label: 'VIP' },
  { key: 'PREMIUM', label: 'Premium' },
  { key: 'REGULAR', label: 'Regular' },
];

export function tierKey(seatType: string | undefined): string {
  const key = (seatType || '').toUpperCase();
  return TIERS.some((t) => t.key === key) ? key : 'REGULAR';
}

export function tierLabel(seatType: string | undefined): string {
  return TIERS.find((t) => t.key === tierKey(seatType))!.label;
}

export function money(value: number | string): string {
  return `$${Number(value).toFixed(2).replace(/\.00$/, '')}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function dateBadge(iso: string): { month: string; day: string } {
  const d = new Date(iso);
  return { month: d.toLocaleDateString(undefined, { month: 'short' }).toUpperCase(), day: String(d.getDate()) };
}

// Flat poster colors per category (text on top is always ink-black).
const CATEGORY_COLORS: Record<string, string> = {
  Concert: '#FF6B9D',
  Theater: '#FF9F1C',
  Sports: '#4D96FF',
  Comedy: '#FFD23F',
  Festival: '#6BCB77',
  Conference: '#B794F6',
};

export function categoryColor(category: string): string {
  return CATEGORY_COLORS[category] || '#CBD5E1';
}

export const CATEGORIES = Object.keys(CATEGORY_COLORS);

// Uploaded artwork if the event has one, otherwise the category's default illustration.
export function eventImage(event: { id: string; category: string; imageUpdatedAt?: string | null }): string {
  if (event.imageUpdatedAt) return `/api/events/${event.id}/image?v=${encodeURIComponent(event.imageUpdatedAt)}`;
  const file = CATEGORY_COLORS[event.category] ? event.category.toLowerCase() : 'default';
  return `/event-defaults/${file}.svg`;
}

export function statusClass(status: string): string {
  return `badge badge-${status.toLowerCase()}`;
}
