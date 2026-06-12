import assert from "node:assert/strict";
import { RateLimiter } from "./rate_limit.ts";

Deno.test("allows bursts up to capacity, then blocks", () => {
  const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1 });
  const t = 1_000_000;
  assert.equal(limiter.check("k", t), true);
  assert.equal(limiter.check("k", t), true);
  assert.equal(limiter.check("k", t), true);
  assert.equal(limiter.check("k", t), false);
});

Deno.test("refills over time at the configured rate", () => {
  const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 0.5 });
  const t = 1_000_000;
  limiter.check("k", t);
  limiter.check("k", t);
  assert.equal(limiter.check("k", t), false);
  // 1s later: only 0.5 tokens — still blocked.
  assert.equal(limiter.check("k", t + 1000), false);
  // 2s later (cumulative): 1 token available.
  assert.equal(limiter.check("k", t + 2000), true);
  assert.equal(limiter.check("k", t + 2000), false);
});

Deno.test("keys are independent", () => {
  const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1 });
  const t = 0;
  assert.equal(limiter.check("a", t), true);
  assert.equal(limiter.check("a", t), false);
  assert.equal(limiter.check("b", t), true);
});

Deno.test("refill never exceeds capacity", () => {
  const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 100 });
  const t = 0;
  limiter.check("k", t);
  // Long idle: bucket caps at 2, not 2 + elapsed*rate.
  assert.equal(limiter.check("k", t + 60_000), true);
  assert.equal(limiter.check("k", t + 60_000), true);
  assert.equal(limiter.check("k", t + 60_000), false);
});

Deno.test("prune drops idle buckets but keeps active ones", () => {
  const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1 });
  limiter.check("idle", 0);
  limiter.check("active", 100_000);
  limiter.prune(100_000);
  assert.equal(limiter.size, 1);
});
