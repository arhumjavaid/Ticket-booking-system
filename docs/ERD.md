# Entity-Relationship Diagram

Source of truth: `packages/database/prisma/schema.prisma`.

```mermaid
erDiagram
    USER ||--o{ BOOKING : places
    USER ||--o{ SEAT_HOLD : holds
    USER ||--o{ NOTIFICATION : receives
    USER ||--o{ AUDIT_LOG : triggers
    USER ||--o{ EVENT : "creates (admin)"

    VENUE ||--o{ VENUE_SECTION : has
    VENUE ||--o{ EVENT : hosts
    VENUE_SECTION ||--o{ SEAT : contains

    EVENT ||--o{ EVENT_SEAT : "inventories seats for"
    EVENT ||--o{ BOOKING : "booked for"
    EVENT ||--o{ SEAT_HOLD : "held for"

    SEAT ||--o{ EVENT_SEAT : "instantiated per event as"

    EVENT_SEAT ||--o{ BOOKING_ITEM : "sold as"
    EVENT_SEAT ||--o{ SEAT_HOLD : "temporarily held as"

    BOOKING ||--|{ BOOKING_ITEM : contains
    BOOKING ||--o| PAYMENT : "paid via"

    USER {
        uuid id PK
        string email UK
        string passwordHash
        string name
        enum role
    }
    VENUE {
        uuid id PK
        string name
        string city
        string address
    }
    VENUE_SECTION {
        uuid id PK
        uuid venueId FK
        string name
    }
    SEAT {
        uuid id PK
        uuid venueSectionId FK
        string rowLabel
        int seatNumber
        string seatType
    }
    EVENT {
        uuid id PK
        uuid venueId FK
        string name
        string category
        string[] tags
        datetime startsAt
        decimal basePrice
        enum status
    }
    EVENT_SEAT {
        uuid id PK
        uuid eventId FK
        uuid seatId FK
        enum status "AVAILABLE|HELD|BOOKED|BLOCKED"
        decimal price
        int version "optimistic concurrency"
        string heldBy
        datetime holdExpiresAt
    }
    SEAT_HOLD {
        uuid id PK
        uuid eventId FK
        uuid seatId
        uuid eventSeatId FK
        uuid userId FK
        enum status "ACTIVE|EXPIRED|CONFIRMED|RELEASED"
        datetime expiresAt
    }
    BOOKING {
        uuid id PK
        uuid userId FK
        uuid eventId FK
        enum status "PENDING|CONFIRMED|CANCELLED|FAILED"
        decimal totalAmount
        string idempotencyKey UK
    }
    BOOKING_ITEM {
        uuid id PK
        uuid bookingId FK
        uuid eventSeatId FK
        uuid seatId
        decimal price
    }
    PAYMENT {
        uuid id PK
        uuid bookingId FK "unique"
        decimal amount
        enum status
        string provider
    }
    NOTIFICATION {
        uuid id PK
        uuid userId FK
        string type
        string channel
        enum status
    }
    AUDIT_LOG {
        uuid id PK
        uuid actorId FK
        string action
        string resourceType
        string resourceId
    }
```

## Why `event_seats` exists separately from `seats`

A physical `Seat` (e.g. "Floor Row A Seat 1") is booked independently for every `Event` held at that venue. `EventSeat` is the per-event inventory row that actually carries `status`, `price`, and the optimistic-concurrency `version` column - `Seat` itself never changes once a venue is configured. This is what makes "Seat A1 is AVAILABLE for Concert-1 but BOOKED for Concert-2" representable at all.
