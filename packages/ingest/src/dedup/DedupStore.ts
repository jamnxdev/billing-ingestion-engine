export type DedupOutcome = "new" | "duplicate" | "conflict";

interface DedupEntry {
  payloadHash: string;
  recordedAtMs: number;
}

/**
 * Idempotency-key deduplication, scoped per tenant and bounded by a fixed
 * time window.
 *
 * Composite key is `JSON.stringify([tenantId, idempotencyKey])` rather than a
 * delimiter-joined string — a delimiter risks collision if either field can
 * itself contain the delimiter (e.g. tenantId `"a:b"` colliding with tenantId
 * `"a"` + key `"b:c"`); JSON array encoding has no such ambiguity.
 *
 * Eviction relies on one invariant: every entry shares the same `windowMs`,
 * so entries expire in exactly the order they were inserted — insertion
 * order is expiry order. That means a single FIFO queue of keys is enough to
 * evict in O(1) amortized per operation, with no need for a full sweep or a
 * priority queue keyed on expiry time.
 */
export class DedupStore {
  private readonly entries = new Map<string, DedupEntry>();
  private readonly insertionOrder: string[] = [];

  constructor(
    private readonly windowMs: number,
    private readonly clock: () => number = Date.now,
  ) {
    if (windowMs <= 0) {
      throw new Error(`windowMs must be positive, got ${windowMs}`);
    }
  }

  /**
   * Checks whether (tenantId, idempotencyKey) has been seen within the
   * window, recording it if not.
   *
   * - "new": first time this key has been seen within the window; recorded.
   * - "duplicate": same key, same payload hash — a legitimate retry, not
   *   double-applied.
   * - "conflict": same key, different payload hash — the caller reused an
   *   idempotency key for what is semantically a different event, which is a
   *   client bug the API boundary must surface rather than silently accept.
   *
   * A duplicate/conflict check does not refresh the entry's recorded time —
   * the window is anchored to first-seen time, not last-seen time, so a
   * client that keeps retrying the same key indefinitely doesn't keep the
   * entry alive forever.
   */
  check(tenantId: string, idempotencyKey: string, hash: string): DedupOutcome {
    this.evictExpired();

    const key = DedupStore.compositeKey(tenantId, idempotencyKey);
    const existing = this.entries.get(key);
    if (existing === undefined) {
      this.entries.set(key, { payloadHash: hash, recordedAtMs: this.clock() });
      this.insertionOrder.push(key);
      return "new";
    }
    return existing.payloadHash === hash ? "duplicate" : "conflict";
  }

  /** Number of live (non-expired, as of the last check/eviction) entries. */
  size(): number {
    return this.entries.size;
  }

  private evictExpired(): void {
    const cutoff = this.clock() - this.windowMs;
    while (this.insertionOrder.length > 0) {
      const oldestKey = this.insertionOrder[0]!;
      // Invariant: insertionOrder and entries are always mutated together,
      // so a key present in insertionOrder is always present in entries.
      const entry = this.entries.get(oldestKey)!;
      if (entry.recordedAtMs > cutoff) {
        break;
      }
      this.insertionOrder.shift();
      this.entries.delete(oldestKey);
    }
  }

  private static compositeKey(tenantId: string, idempotencyKey: string): string {
    return JSON.stringify([tenantId, idempotencyKey]);
  }
}
