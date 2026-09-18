/**
 * A standard per-key token bucket: each key gets its own bucket of
 * `capacity` tokens, refilling continuously at `refillPerSecond` tokens per
 * second, capped at `capacity`. Used to rate-limit ingestion per tenant so
 * one misbehaving client can't degrade another tenant's aggregation
 * latency — the exact concern the spec's own security considerations name.
 *
 * Refill is computed lazily, on each `tryConsume` call, from elapsed wall
 * time since the bucket's last touch — not via a background timer — the
 * same "no timer, just compute from an injectable clock" discipline
 * `DedupStore`'s window eviction already established.
 */
export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; lastRefillMs: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly clock: () => number = Date.now,
  ) {
    if (capacity <= 0) {
      throw new Error(`capacity must be positive, got ${capacity}`);
    }
    if (refillPerSecond <= 0) {
      throw new Error(`refillPerSecond must be positive, got ${refillPerSecond}`);
    }
  }

  /** Attempts to consume one token for `key`. Returns true if allowed (and consumes it), false if the bucket is empty. */
  tryConsume(key: string): boolean {
    const bucket = this.refill(key);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Seconds until at least one token will be available for `key` — used to set a `Retry-After` header. 0 if a token is already available. */
  secondsUntilNextToken(key: string): number {
    const bucket = this.refill(key);
    if (bucket.tokens >= 1) {
      return 0;
    }
    return (1 - bucket.tokens) / this.refillPerSecond;
  }

  private refill(key: string): { tokens: number; lastRefillMs: number } {
    const now = this.clock();
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: this.capacity, lastRefillMs: now };
      this.buckets.set(key, bucket);
      return bucket;
    }
    const elapsedSeconds = Math.max(0, (now - bucket.lastRefillMs) / 1000);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);
    bucket.lastRefillMs = now;
    return bucket;
  }
}
