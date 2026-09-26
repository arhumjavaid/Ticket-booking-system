# Architecture

This document describes the "Distributed Event Booking Architecture (Enhanced)" as actually implemented in this repository.

## Layers

```
Clients (Browser, Mobile-capable REST API)
   |
Edge Layer (Nginx + in-request Bloom Filter checks)
   |
API Layer (api-1, api-2, api-3 - stateless)
   |
Data & Services Layer (Redis, Booking Service, RabbitMQ, Postgres Cluster, OpenSearch, ClickHouse)
   |
Evaluation & Monitoring (k6, Jest, Prometheus, Grafana)
```

## Mermaid diagram

```mermaid
flowchart TB
    subgraph Clients
        Browser["Web Browser"]
        Mobile["Mobile App (REST client)"]
    end

    subgraph Edge["Edge Layer"]
        WAF["CDN / WAF (conceptual - see docs/PRODUCTION.md)"]
        Nginx["Nginx Load Balancer\n(least_conn, passive health checks)"]
    end

    subgraph API["API Layer (stateless)"]
        API1["api-1"]
        API2["api-2"]
        API3["api-3"]
    end

    subgraph Data["Data & Services Layer"]
        Redis["Redis\n(cache, locks, holds, rate limits,\nbloom filters, sessions)"]
        Booking["Booking Service\n(distributed lock + Postgres transaction)"]
        MQ["RabbitMQ\ntopic exchange: booking.events"]
        PG["PostgreSQL Cluster"]
        PGP["Primary\n(all writes)"]
        PGR1["Replica 1"]
        PGR2["Replica 2"]
        Search["OpenSearch"]
        Analytics["ClickHouse"]
    end

    subgraph Async["Async Consumers"]
        Notif["Notification Service"]
        AnalyticsSvc["Analytics Service"]
        SearchSvc["Search Indexer Service"]
        Worker["Worker\n(expired-hold sweeper, bloom rebuild)"]
    end

    subgraph Obs["Evaluation & Monitoring"]
        K6["k6 Load Tests"]
        Jest["Jest: unit / integration / concurrency"]
        Prom["Prometheus"]
        Graf["Grafana"]
    end

    Browser --> WAF --> Nginx
    Mobile --> WAF
    Nginx --> API1 & API2 & API3

    API1 & API2 & API3 --> Redis
    API1 & API2 & API3 --> Booking
    API1 & API2 & API3 -. cache-aside reads .-> PGR1
    API1 & API2 & API3 -. cache-aside reads .-> PGR2
    API1 & API2 & API3 --> Search
    API1 & API2 & API3 --> Analytics

    Booking --> Redis
    Booking -- writes/transactions --> PGP
    PGP -- streaming replication --> PGR1
    PGP -- streaming replication --> PGR2
    Booking --> MQ

    MQ --> Notif
    MQ --> AnalyticsSvc
    MQ --> SearchSvc
    Worker --> PGP
    Worker --> Redis
    Worker --> MQ

    AnalyticsSvc --> Analytics
    SearchSvc --> Search
    SearchSvc -. reads for reindex .-> PGR1

    K6 --> Nginx
    Jest --> Nginx
    API1 & API2 & API3 & Booking & Worker & Notif & AnalyticsSvc & SearchSvc -. /metrics .-> Prom
    Prom --> Graf
```

## Why each piece is there

| Component | Purpose | Code |
|---|---|---|
| Nginx | Load balances across stateless API instances, least_conn + passive health checks | `infrastructure/nginx/nginx.conf` |
| Bloom Filter | Rejects definitely-nonexistent usernames/events/bookings/seats before a DB round trip | `packages/redis/src/bloomFilter.ts` |
| API-1/2/3 | Stateless HTTP layer: auth, events, seats, search/analytics proxy, SSE | `apps/api` |
| Redis | Cache-aside, distributed locks, seat holds, rate limiting, sessions, bloom filter bitsets | `packages/redis` |
| Booking Service | The only writer of booking state; owns the lock + transaction + idempotency logic | `apps/booking-service` |
| RabbitMQ | Topic exchange decoupling booking confirmation from notification/analytics/search | `packages/messaging` |
| PostgreSQL Cluster | Source of truth; primary for writes, replicas for reads, real streaming replication | `infrastructure/postgres` |
| Worker | Sweeps expired seat holds back to AVAILABLE; rebuilds bloom filters on boot | `apps/worker` |
| OpenSearch | Full text + filtered event search, eventually consistent | `services/search-service` |
| ClickHouse | OLAP analytics off the booking critical path | `services/analytics-service` |
| Prometheus/Grafana | Metrics scraping + dashboards | `infrastructure/prometheus`, `infrastructure/grafana` |

See `docs/DISTRIBUTED_SYSTEMS.md` for the consistency/locking/replication explanation and `docs/ARCHITECTURE_AUDIT.md` for the full per-component audit table required by the project brief.
