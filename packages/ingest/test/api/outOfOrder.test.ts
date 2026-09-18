import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { buildServer } from "../../src/api/server.js";
import type { UsageEvent } from "@billing/aggregator";
import { TEST_API_KEYS, GENEROUS_RATE_LIMIT, postEvent } from "../testHelpers.js";

const BUCKET_MS = 60_000;

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  let state = seed | 0;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

describe("Out-of-order arrival through the full ingestion HTTP path", () => {
  it("reaches the same final aggregate total regardless of the order events are POSTed in", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            quantity: fc.integer({ min: 1, max: 100 }),
            occurredAtMs: fc.integer({ min: 0, max: 5_000_000 }),
          }),
          { minLength: 1, maxLength: 40 },
        ),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        async (partials, shuffleSeed) => {
          const events: UsageEvent[] = partials.map((p, i) => ({
            tenantId: "tenant-a",
            idempotencyKey: `key-${i}`,
            metric: "api_calls",
            ...p,
          }));
          const expectedTotal = events.reduce((sum, e) => sum + e.quantity, 0);

          const app = buildServer({
            dedupWindowMs: 1000,
            bucketSizeMs: BUCKET_MS,
            apiKeys: TEST_API_KEYS,
            rateLimit: GENEROUS_RATE_LIMIT,
          });
          for (const event of seededShuffle(events, shuffleSeed)) {
            const res = await postEvent(app, event);
            expect(res.statusCode).toBe(202);
          }

          const res = await app.inject({
            method: "GET",
            url: "/aggregates/tenant-a?metric=api_calls",
          });
          expect(res.json()).toEqual({ tenantId: "tenant-a", totals: { api_calls: expectedTotal } });
        },
      ),
      { numRuns: 50 }, // fewer runs than the in-memory aggregator property test — each run drives real HTTP requests
    );
  });

  it("a late-arriving retry of an earlier event is still deduplicated correctly, even when many newer events arrived first", async () => {
    const app = buildServer({
      dedupWindowMs: 10_000,
      bucketSizeMs: BUCKET_MS,
      apiKeys: TEST_API_KEYS,
      rateLimit: GENEROUS_RATE_LIMIT,
    });

    const original: UsageEvent = {
      tenantId: "tenant-a",
      idempotencyKey: "key-original",
      metric: "api_calls",
      quantity: 10,
      occurredAtMs: 0,
    };
    const first = await postEvent(app, original);
    expect(first.statusCode).toBe(202);

    // Many newer, unrelated events arrive next.
    for (let i = 1; i <= 20; i++) {
      await postEvent(app, {
        tenantId: "tenant-a",
        idempotencyKey: `key-${i}`,
        metric: "api_calls",
        quantity: 1,
        occurredAtMs: i * BUCKET_MS,
      });
    }

    // The original event's client retries it late — must be recognized as a duplicate,
    // not double-counted, despite arriving long after 20 other distinct events.
    const retry = await postEvent(app, original);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ status: "duplicate" });

    const res = await app.inject({ method: "GET", url: "/aggregates/tenant-a?metric=api_calls" });
    expect(res.json()).toEqual({ tenantId: "tenant-a", totals: { api_calls: 10 + 20 } });
  });
});
