import { SeatView } from '../types';

interface SeatMapProps {
  seats: SeatView[];
  selectedSeatIds: Set<string>;
  onToggle: (seat: SeatView) => void;
}

const STATUS_LABEL: Record<string, string> = {
  AVAILABLE: 'Available',
  HELD: 'Held',
  BOOKED: 'Booked',
  BLOCKED: 'Blocked',
};

export function SeatMap({ seats, selectedSeatIds, onToggle }: SeatMapProps) {
  const sections = Array.from(new Set(seats.map((s) => s.section)));

  return (
    <div className="seat-map">
      <div className="seat-legend">
        {Object.entries(STATUS_LABEL).map(([status, label]) => (
          <span key={status} className={`legend-item seat-${status.toLowerCase()}`}>
            {label}
          </span>
        ))}
        <span className="legend-item seat-selected">Selected</span>
      </div>

      {sections.map((section) => {
        const sectionSeats = seats.filter((s) => s.section === section);
        const rows = Array.from(new Set(sectionSeats.map((s) => s.row))).sort();
        return (
          <div key={section} className="seat-section">
            <h4>{section}</h4>
            {rows.map((row) => (
              <div key={row} className="seat-row">
                <span className="row-label">{row}</span>
                {sectionSeats
                  .filter((s) => s.row === row)
                  .sort((a, b) => a.number - b.number)
                  .map((seat) => {
                    const selected = selectedSeatIds.has(seat.seatId);
                    const clickable = seat.status === 'AVAILABLE';
                    return (
                      <button
                        key={seat.seatId}
                        disabled={!clickable && !selected}
                        onClick={() => onToggle(seat)}
                        title={`${section} ${row}${seat.number} - $${seat.price} - ${seat.status}`}
                        className={`seat-cell seat-${seat.status.toLowerCase()} ${selected ? 'seat-selected' : ''}`}
                      >
                        {seat.number}
                      </button>
                    );
                  })}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
