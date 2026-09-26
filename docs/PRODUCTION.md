# Production Deployment Guide

This repository is a **local, functionally-real** implementation of the architecture - every distributed-systems mechanism (locking, replication, sharding, queues) is genuinely implemented, not mocked. This document lists what changes to run it for real, and why each local simplification was made.

## Local dev vs. production

| Concern | Local (this repo) | Production |
|---|---|---|
| Redis | Single container | Redis Cluster (3+ masters, replicas). `packages/redis/src/client.ts` only uses commands/Lua scripts that work identically against `Redis.Cluster` - swap the constructor, no other code changes |
| RabbitMQ | Single container, no HA | Mirrored/quorum queues across a 3-node cluster, or migrate to a managed broker (Amazon MQ, CloudAMQP) |
| PostgreSQL | 1 primary + 2 manually-managed streaming replicas | Managed HA (RDS Multi-AZ, Patroni/Stolon-managed cluster) with automatic failover - this repo's primary has **no automatic failover**, which is why `tests/failure/run-db-failure.sh` expects writes to fail closed, not silently recover |
| Sharding | Off by default; 3-shard hash routing available via a compose profile | Same routing logic, but shard provisioning/rebalancing would be automated (e.g. Vitess, Citus, or a custom control plane) rather than static `SHARD_i_URL` env vars |
| OpenSearch/ClickHouse | Single-node, security plugin disabled | Multi-node clusters, TLS + auth enabled, proper index lifecycle/retention policies |
| Message delivery guarantee | At-least-once with retry + DLQ; publish failures after a successful DB commit are logged and dropped | Add a **transactional outbox** table written in the same DB transaction as the booking, with a relay process guaranteeing delivery even across a full process/broker outage |
| CDN/WAF | Not implemented (out of scope for a local stack) | CloudFront/Cloudflare in front of Nginx for static assets, DDoS protection, and edge caching |
| Nginx health checks | Passive (`max_fails`/`fail_timeout`) - open-source Nginx has no active health checks | Nginx Plus, or move load balancing to a cloud LB / service mesh (Envoy) with active health checks |
| TLS | None (plain HTTP on `:8080`) | Terminate TLS at the CDN/LB; internal traffic over a private VPC or mTLS via a service mesh |
| Secrets | Plaintext in `.env` | A real secrets manager (Vault, AWS Secrets Manager) injected at deploy time |
| Docker images | One shared `Dockerfile.node` builds the whole monorepo per image (`base` stage cost, layer-cached) | Prune each final image to just its own `dist/` + production deps (e.g. via a proper monorepo build tool), and use a private registry with vulnerability scanning |
| Horizontal scaling | 3 fixed `api-N` containers | An autoscaling group / Kubernetes Deployment + HPA driven by `http_requests_total`/CPU, fronted by a real load balancer |
| Observability | Prometheus + Grafana in-cluster, no long-term storage | Remote-write to a managed TSDB (Mimir, Thanos, Cortex) for retention; add alerting rules + on-call paging |

## Operational gotcha: Nginx caches upstream DNS at startup

Open-source Nginx resolves the hostnames in an `upstream {}` block **once**, when it starts, and holds onto those IPs for the life of the process - it does not notice if `api-1`/`api-2`/`api-3` get recreated later with new container IPs (which happens whenever you `docker compose up -d --build api-N`, but not on a normal `docker compose restart api-N`, which keeps the same IP). If you rebuild/recreate an API container and start seeing intermittent `502`s from Nginx afterward, that's this - not a booking-correctness bug. Fix locally with:

```bash
docker compose restart nginx
```

In production this is solved properly by either Nginx Plus (which supports dynamic re-resolution of upstream servers), a `resolver` + variable-based `proxy_pass` pointing at Docker's embedded DNS (trading away `least_conn`/passive health checks for that flexibility), or - more realistically - replacing Nginx entirely with a cloud load balancer or service-mesh sidecar that does real service discovery (see the Nginx row in the table above).

## Rollout checklist for a real deployment

1. Move all credentials out of `.env` into a secrets manager; rotate the seeded dev passwords.
2. Stand up managed Postgres with automatic failover; point `DATABASE_URL`/`REPLICA_DATABASE_URLS` at it.
3. Stand up Redis Cluster and RabbitMQ (or managed equivalents); update `REDIS_URL`/`RABBITMQ_URL`.
4. Add a transactional outbox + relay for booking events if delivery guarantees stronger than "best effort after commit" are required.
5. Put a real CDN/WAF and TLS termination in front of Nginx (or replace Nginx with a cloud load balancer).
6. Wire Prometheus remote-write to long-term storage and add alerting rules for `seat_booking_conflict_total`, `booking_failure_total`, `queue_processing_failures_total`, and replica lag.
7. Load test at expected peak (see `docs/LOAD_TESTING.md`) against the real infrastructure before launch, not just this local stack.
