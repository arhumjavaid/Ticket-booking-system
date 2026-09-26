# Concurrency Control Explained

This system deliberately layers **pessimistic** and **optimistic** concurrency control on the same operation (section 11), plus a **distributed lock** in front of both (section 9). This document explains why all three exist rather than just one.

## The three layers, in the order a request passes through them

1. **Redis distributed lock** - `packages/redis/src/lock.ts`. `SET lock:event:{id}:seat:{id} <token> NX PX <ttl>`. Purpose: cheap, fast rejection of the losing side of a race, *before* a database connection is even opened. Not itself sufficient for correctness (see `docs/DISTRIBUTED_SYSTEMS.md`).

2. **Pessimistic locking** - `SELECT * FROM event_seats WHERE event_id=? AND seat_id=? FOR UPDATE` inside a transaction (`apps/booking-service/src/services/holdService.ts` and `bookingService.ts`). This takes an actual row-level lock in Postgres, so even two processes that *both* somehow believed they held the Redis lock (e.g. after a TTL expiry race) cannot both proceed past this point simultaneously - the second transaction blocks until the first commits or rolls back, then re-reads the now-updated row.

3. **Optimistic concurrency** - the `version` column on `event_seats`. Every update is `UPDATE event_seats SET status=..., version = version + 1 WHERE id = ? AND version = ?`. Combined with `updateMany()`'s returned `count`, this detects "did the row actually change under me" even in code paths that don't take the `FOR UPDATE` lock explicitly, and documents the intent explicitly in the write itself rather than relying purely on lock scope.

## Why not just pick one?

- **Lock only, no transaction**: if Redis loses the lock's key (crash without persistence, network partition) between acquisition and Postgres commit, two processes can both proceed to write - Redis is an accelerator, and RULE 2 says it must never be the source of truth for booking correctness.
- **Transaction only, no Redis lock**: correctness is unaffected, but every one of N concurrent requests for the same hot seat opens a full Postgres connection + transaction just to get told "no" - hostile to connection pool exhaustion under a real flash-sale spike (section 37/38). The Redis lock turns "N transactions, N-1 of them wasted" into "1 transaction, N-1 rejected before touching Postgres at all."
- **Optimistic only, no `FOR UPDATE`**: without a row lock, N transactions could all read `version=3` simultaneously, all attempt `UPDATE ... WHERE version=3`, and Postgres's MVCC would serialize the writes anyway (only one `UPDATE` actually succeeds due to a write-write conflict / one of them blocks and then sees a stale `version` on retry) - but this pushes the conflict resolution into retry logic and burns more transaction aborts than an explicit `FOR UPDATE`, which resolves ordering deterministically up front.

## Deadlock avoidance for multi-seat bookings

`createBooking()` and `cancelBooking()` both sort `seatIds` before acquiring locks (`apps/booking-service/src/services/bookingService.ts`, `withNestedLocks`). Two concurrent multi-seat bookings that both touch seats `{A1, A2}` will always attempt to lock them in the same order (`A1` then `A2`), so one waits behind the other instead of each holding one lock and waiting on the other's - the classic deadlock shape - which cannot occur here by construction.

## Where to see it tested

- `tests/unit/lock.test.ts` - lock mutual exclusion, TTL expiry, token-based release safety
- `tests/unit/idempotency.test.ts` - a repeated request never re-enters the lock/transaction path
- `tests/concurrency/seatRace.test.ts` - the end-to-end proof: N concurrent HTTP requests through Nginx for one seat yield exactly one winner
