jest.mock('ioredis', () => require('ioredis-mock'));

import { BloomFilter, redis } from '@ticketing/redis';

afterAll(() => redis.disconnect());

describe('BloomFilter', () => {
  it('never produces a false negative for an added item', async () => {
    const filter = new BloomFilter('test-no-false-negatives', 1000, 0.01);
    const items = Array.from({ length: 500 }, (_, i) => `item-${i}`);

    for (const item of items) {
      await filter.add(item);
    }

    for (const item of items) {
      expect(await filter.mightExist(item)).toBe(true);
    }
  });

  it('reports items that were never added as not existing (in the common case)', async () => {
    const filter = new BloomFilter('test-negatives', 1000, 0.01);
    await filter.populate(['registered-user@example.com']);

    // Not a guarantee for every possible string (false positives are
    // allowed), but a filter sized for 1000 items with 1% target FP rate
    // should reject the overwhelming majority of never-added items.
    let falsePositives = 0;
    const trials = 200;
    for (let i = 0; i < trials; i++) {
      const exists = await filter.mightExist(`never-added-${i}@example.com`);
      if (exists) falsePositives++;
    }
    expect(falsePositives / trials).toBeLessThan(0.1);
  });

  it('answers "might exist" for everything until populated from the database', async () => {
    const filter = new BloomFilter('test-unpopulated', 1000, 0.01);
    expect(await filter.mightExist('never-added')).toBe(true);

    await filter.populate([]);
    expect(await filter.mightExist('never-added')).toBe(false);
  });

  it('fails open again after Redis loses the filter, even if new items were added since', async () => {
    const filter = new BloomFilter('test-flushed', 1000, 0.01);
    await filter.populate(['user-from-db']);
    expect(await filter.mightExist('user-from-db')).toBe(true);

    await redis.flushall();
    await filter.add('registered-after-flush'); // recreates the bitset, but not the ready marker

    expect(await filter.isReady()).toBe(false);
    expect(await filter.mightExist('user-from-db')).toBe(true);
  });

  it('populate keeps items added before or during it', async () => {
    const filter = new BloomFilter('test-populate', 1000, 0.01);
    await filter.add('added-live');

    await filter.populate(['from-db-1', 'from-db-2']); // DB snapshot that missed 'added-live'

    for (const item of ['added-live', 'from-db-1', 'from-db-2']) {
      expect(await filter.mightExist(item)).toBe(true);
    }
  });
});
