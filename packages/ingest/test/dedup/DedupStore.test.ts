import { describe, expect, it } from "vitest";
import { DedupStore } from "../../src/dedup/DedupStore.js";

function fakeClock(startMs: number) {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("DedupStore", () => {
  it("rejects a non-positive window", () => {
    expect(() => new DedupStore(0)).toThrow();
    expect(() => new DedupStore(-1)).toThrow();
  });

  it("returns 'new' the first time a (tenant, key) pair is seen", () => {
    const store = new DedupStore(1000, () => 0);
    expect(store.check("tenant-a", "key-1", "hash-1")).toBe("new");
    expect(store.size()).toBe(1);
  });

  it("returns 'duplicate' for the same (tenant, key) with the same payload hash", () => {
    const store = new DedupStore(1000, () => 0);
    store.check("tenant-a", "key-1", "hash-1");
    expect(store.check("tenant-a", "key-1", "hash-1")).toBe("duplicate");
    expect(store.size()).toBe(1);
  });

  it("returns 'conflict' for the same (tenant, key) with a different payload hash", () => {
    const store = new DedupStore(1000, () => 0);
    store.check("tenant-a", "key-1", "hash-1");
    expect(store.check("tenant-a", "key-1", "hash-2")).toBe("conflict");
  });

  it("scopes keys per tenant — the same idempotency key on two tenants does not collide", () => {
    const store = new DedupStore(1000, () => 0);
    expect(store.check("tenant-a", "key-1", "hash-1")).toBe("new");
    expect(store.check("tenant-b", "key-1", "hash-1")).toBe("new");
    expect(store.size()).toBe(2);
  });

  it("does not confuse tenantId/key boundaries via naive string concatenation", () => {
    const store = new DedupStore(1000, () => 0);
    expect(store.check("a:b", "c", "hash-1")).toBe("new");
    expect(store.check("a", "b:c", "hash-1")).toBe("new");
    expect(store.size()).toBe(2);
  });

  it("expires an entry once the window has elapsed, allowing the key to be reused as 'new'", () => {
    const clock = fakeClock(0);
    const store = new DedupStore(1000, clock.now);
    expect(store.check("tenant-a", "key-1", "hash-1")).toBe("new");

    clock.advance(999);
    expect(store.check("tenant-a", "key-1", "hash-1")).toBe("duplicate");

    clock.advance(2); // now at 1001ms since recordedAt=0, past the 1000ms window
    expect(store.check("tenant-a", "key-1", "hash-1")).toBe("new");
  });

  it("does not refresh an entry's expiry on a duplicate check (window anchored to first-seen time)", () => {
    const clock = fakeClock(0);
    const store = new DedupStore(1000, clock.now);
    store.check("tenant-a", "key-1", "hash-1");

    clock.advance(900);
    expect(store.check("tenant-a", "key-1", "hash-1")).toBe("duplicate");

    clock.advance(200); // total 1100ms since first-seen — expired, despite the duplicate check at 900ms
    expect(store.check("tenant-a", "key-1", "hash-1")).toBe("new");
  });

  it("evicts multiple expired entries in insertion order as time advances", () => {
    const clock = fakeClock(0);
    const store = new DedupStore(100, clock.now);
    store.check("tenant-a", "key-1", "h1");
    clock.advance(50);
    store.check("tenant-a", "key-2", "h2");
    clock.advance(50); // key-1 now at age 100 (expired), key-2 at age 50 (alive)
    store.check("tenant-a", "key-3", "h3");

    expect(store.size()).toBe(2); // key-1 evicted, key-2 and key-3 remain
    expect(store.check("tenant-a", "key-1", "h1")).toBe("new");
    expect(store.check("tenant-a", "key-2", "h2")).toBe("duplicate");
  });
});
