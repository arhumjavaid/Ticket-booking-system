import { redis } from './client';

/**
 * Redis-backed Bloom filter.
 *
 * Why Redis-backed rather than in-process: API servers are stateless and
 * horizontally scaled (api-1/2/3). An in-memory bloom filter on api-1 would
 * know nothing about a user registered via api-2, which would reintroduce
 * per-instance state we are explicitly forbidden from having. Backing the
 * bit array with Redis SETBIT/GETBIT makes the filter itself a piece of
 * shared, stateless-friendly infrastructure.
 *
 * GUARANTEE: mightExist() NEVER returns false for an item that was add()-ed.
 * It CAN return true for an item that was never added (false positive) -
 * that is the accepted tradeoff. Callers must always treat a `true` result
 * as "go check the database", never as confirmation.
 */
export class BloomFilter {
  private readonly key: string;
  private readonly size: number; // m: number of bits
  private readonly hashCount: number; // k: number of hash functions

  constructor(name: string, expectedItems: number, falsePositiveRate = 0.01) {
    this.key = `bloom:${name}`;
    this.size = BloomFilter.optimalSize(expectedItems, falsePositiveRate);
    this.hashCount = BloomFilter.optimalHashCount(expectedItems, this.size);
  }

  static optimalSize(n: number, p: number): number {
    const m = Math.ceil((-n * Math.log(p)) / (Math.log(2) ** 2));
    return Math.max(m, 8);
  }

  static optimalHashCount(n: number, m: number): number {
    const k = Math.round((m / n) * Math.log(2));
    return Math.max(k, 1);
  }

  private positions(item: string): number[] {
    const [h1, h2] = BloomFilter.doubleHash(item);
    const positions: number[] = [];
    for (let i = 0; i < this.hashCount; i++) {
      const combined = (h1 + i * h2) >>> 0;
      positions.push(combined % this.size);
    }
    return positions;
  }

  /** FNV-1a with two different seeds, used for Kirsch-Mitzenmacher double hashing. */
  private static doubleHash(item: string): [number, number] {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < item.length; i++) {
      const c = item.charCodeAt(i);
      h1 ^= c;
      h1 = Math.imul(h1, 0x01000193);
      h2 ^= c;
      h2 = Math.imul(h2, 0x811c9dc5);
    }
    return [h1 >>> 0, h2 >>> 0];
  }

  async add(item: string): Promise<void> {
    const positions = this.positions(item);
    const pipeline = redis.pipeline();
    for (const pos of positions) {
      pipeline.setbit(this.key, pos, 1);
    }
    await pipeline.exec();
  }

  async addMany(items: string[]): Promise<void> {
    if (items.length === 0) return;
    const pipeline = redis.pipeline();
    for (const item of items) {
      for (const pos of this.positions(item)) {
        pipeline.setbit(this.key, pos, 1);
      }
    }
    await pipeline.exec();
  }

  /** true => "may exist, check the DB". false => "definitely does not exist". */
  async mightExist(item: string): Promise<boolean> {
    try {
      const positions = this.positions(item);
      const pipeline = redis.pipeline();
      for (const pos of positions) {
        pipeline.getbit(this.key, pos);
      }
      const results = await pipeline.exec();
      if (!results) return true; // fail open toward the DB, never toward false negatives
      return results.every(([err, bit]) => !err && bit === 1);
    } catch {
      // Redis unreachable: fail open. A bloom filter is an optimization -
      // it must NEVER be the reason a real record looks like it doesn't
      // exist, so an infra failure here degrades to "always check the DB".
      return true;
    }
  }

  /** Wipes and rebuilds the filter from an authoritative list (used at service boot). */
  async rebuild(items: string[]): Promise<void> {
    await redis.del(this.key);
    await this.addMany(items);
  }
}

export const usernameBloomFilter = new BloomFilter('usernames', 100_000, 0.01);
export const eventBloomFilter = new BloomFilter('events', 10_000, 0.01);
export const bookingBloomFilter = new BloomFilter('bookings', 500_000, 0.01);
export const eventSeatBloomFilter = new BloomFilter('event_seats', 1_000_000, 0.01);
