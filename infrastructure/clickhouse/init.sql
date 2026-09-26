-- Analytics database. Populated asynchronously by services/analytics-service
-- consuming the RabbitMQ topic exchange. Never queried on the booking
-- critical path (RULE 7) - PostgreSQL remains the transactional source of
-- truth; this is purely an OLAP sink for reporting/dashboards.

CREATE DATABASE IF NOT EXISTS analytics;

CREATE TABLE IF NOT EXISTS analytics.booking_events
(
    event_id       String,
    routing_key    LowCardinality(String),
    occurred_at    DateTime64(3),
    ticket_event_id String,
    booking_id     String,
    user_id        String,
    seat_id        String,
    seat_count     UInt16 DEFAULT 0,
    amount         Decimal(10, 2) DEFAULT 0,
    ingested_at    DateTime64(3) DEFAULT now64(3)
)
-- ReplacingMergeTree keyed by event_id gives idempotent ingestion (RULE 11):
-- redelivering the same domain event (retry, consumer restart) overwrites
-- rather than double-counts once merged. Queries that need exact
-- correctness before a background merge runs should add `FINAL`.
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (event_id);
