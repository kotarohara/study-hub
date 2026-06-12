// In-process token-bucket rate limiter (spec §6: Caddy rate limiting plus
// app-level limits; no external store — single-instance deployment).

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimiterOptions {
  /** Burst capacity (also the starting balance). */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private opts: RateLimiterOptions) {}

  /** Consumes one token for `key`; false when the bucket is empty. */
  check(key: string, nowMs = Date.now()): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.opts.capacity, lastRefill: nowMs };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = (nowMs - bucket.lastRefill) / 1000;
      bucket.tokens = Math.min(
        this.opts.capacity,
        bucket.tokens + elapsed * this.opts.refillPerSecond,
      );
      bucket.lastRefill = nowMs;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Drops full, idle buckets so the map does not grow unbounded. */
  prune(nowMs = Date.now()): void {
    const idleMs = (this.opts.capacity / this.opts.refillPerSecond) * 1000 * 2;
    for (const [key, bucket] of this.buckets) {
      if (nowMs - bucket.lastRefill > idleMs) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
