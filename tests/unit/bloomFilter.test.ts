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
    await filter.add('registered-user@example.com');

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

  it('addMany + rebuild replaces the filter contents', async () => {
    const filter = new BloomFilter('test-rebuild', 1000, 0.01);
    await filter.add('stale-item');
    expect(await filter.mightExist('stale-item')).toBe(true);

    await filter.rebuild(['fresh-item-1', 'fresh-item-2']);

    expect(await filter.mightExist('fresh-item-1')).toBe(true);
    expect(await filter.mightExist('fresh-item-2')).toBe(true);
  });
});
