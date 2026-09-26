import { ShardRouter, CrossShardWriteError } from '@ticketing/database';

describe('ShardRouter', () => {
  const router = new ShardRouter();

  it('deterministically routes the same event id to the same shard every time', () => {
    const eventId = 'event-abc-123';
    const first = router.shardIndexForEvent(eventId);
    const second = router.shardIndexForEvent(eventId);
    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(router.shardCount);
  });

  it('distributes many event ids across all configured shards (no shard starved)', () => {
    const counts = new Array(router.shardCount).fill(0);
    for (let i = 0; i < 300; i++) {
      counts[router.shardIndexForEvent(`event-${i}`)]++;
    }
    for (const count of counts) {
      expect(count).toBeGreaterThan(0);
    }
  });

  it('allows a batch of event ids that all resolve to the same shard', () => {
    // Find two ids that land on the same shard.
    const byShard = new Map<number, string>();
    for (let i = 0; i < 100 && byShard.size < router.shardCount; i++) {
      const id = `find-${i}`;
      byShard.set(router.shardIndexForEvent(id), id);
    }
    const [idx, idA] = [...byShard.entries()][0];
    let idB = idA;
    for (let i = 0; i < 200; i++) {
      const candidate = `same-shard-${i}`;
      if (router.shardIndexForEvent(candidate) === idx) {
        idB = candidate;
        break;
      }
    }
    expect(() => router.assertSingleShard([idA, idB])).not.toThrow();
  });

  it('refuses a write spanning two different shards (RULE: prevent cross-shard writes)', () => {
    // Brute force two ids landing on different shards - guaranteed to exist
    // quickly since shardCount === 3 in the test env.
    let idA = '';
    let idB = '';
    for (let i = 0; i < 500; i++) {
      const candidate = `probe-${i}`;
      if (!idA) {
        idA = candidate;
        continue;
      }
      if (router.shardIndexForEvent(candidate) !== router.shardIndexForEvent(idA)) {
        idB = candidate;
        break;
      }
    }
    expect(idB).not.toBe('');
    expect(() => router.assertSingleShard([idA, idB])).toThrow(CrossShardWriteError);
  });
});
