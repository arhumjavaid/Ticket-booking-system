import { SeatView } from '../types';
import { money, tierKey, tierLabel } from '../ui';

interface SeatMapProps {
  seats: SeatView[];
  selectedSeatIds: Set<string>;
  onToggle: (seat: SeatView) => void;
  activeTier: string | null;
  pendingSeatId: string | null;
}

const STATUS_TEXT: Record<string, string> = {
  AVAILABLE: 'available',
  HELD: 'on hold',
  BOOKED: 'sold',
  BLOCKED: 'unavailable',
};

export function SeatMap({ seats, selectedSeatIds, onToggle, activeTier, pendingSeatId }: SeatMapProps) {
  const sections = Array.from(new Set(seats.map((s) => s.section)));

  return (
    <div className="seat-map card">
      <div className="stage">STAGE</div>

      {sections.map((section) => {
        const sectionSeats = seats.filter((s) => s.section === section);
        const rows = Array.from(new Set(sectionSeats.map((s) => s.row))).sort();
        const sectionTiers = Array.from(new Set(sectionSeats.map((s) => tierKey(s.seatType))));
        return (
          <div key={section} className="seat-section">
            <div className="seat-section-title">
              {sectionTiers.map((t) => (
                <span key={t} className={`tier-dot tier-${t.toLowerCase()}`} aria-hidden="true" />
              ))}
              {section}
            </div>
            {rows.map((row) => (
              <div key={row} className="seat-row">
                <span className="row-label">{row}</span>
                {sectionSeats
                  .filter((s) => s.row === row)
                  .sort((a, b) => a.number - b.number)
                  .map((seat) => {
                    const selected = selectedSeatIds.has(seat.seatId);
                    const clickable = seat.status === 'AVAILABLE' || selected;
                    const tier = tierKey(seat.seatType);
                    const dimmed = activeTier !== null && activeTier !== tier && !selected;
                    const label = `${section} row ${row} seat ${seat.number}, ${tierLabel(seat.seatType)}, ${money(seat.price)}, ${
                      selected ? 'selected' : STATUS_TEXT[seat.status] || seat.status
                    }`;
                    return (
                      <button
                        key={seat.seatId}
                        type="button"
                        disabled={!clickable || pendingSeatId === seat.seatId}
                        onClick={() => onToggle(seat)}
                        title={label}
                        aria-label={label}
                        aria-pressed={selected}
                        className={`seat-cell tier-${tier.toLowerCase()} seat-${seat.status.toLowerCase()} ${
                          selected ? 'seat-selected' : ''
                        } ${dimmed ? 'dimmed' : ''}`}
                      >
                        {seat.number}
                      </button>
                    );
                  })}
                <span className="row-label">{row}</span>
              </div>
            ))}
          </div>
        );
      })}

      <div className="seat-legend">
        <span className="legend-item">
          <span className="legend-swatch available" /> Available
        </span>
        <span className="legend-item">
          <span className="legend-swatch selected" /> Your selection
        </span>
        <span className="legend-item">
          <span className="legend-swatch taken" /> On hold
        </span>
        <span className="legend-item">
          <span className="legend-swatch booked" /> Sold
        </span>
      </div>
    </div>
  );
}
