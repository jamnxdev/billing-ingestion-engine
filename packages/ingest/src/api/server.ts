import Fastify, { type FastifyInstance } from "fastify";
import { usageEventSchema, SlidingWindowAggregator, type UsageEvent } from "@billing/aggregator";
import { DedupStore } from "../dedup/DedupStore.js";
import { payloadHash } from "../dedup/payloadHash.js";

export interface BuildServerOptions {
  /** Bounded dedup window, in milliseconds. */
  dedupWindowMs: number;
  /** Aggregation bucket width, in milliseconds. */
  bucketSizeMs: number;
  /** Injectable clock, so dedup-window tests don't depend on real time. */
  clock?: () => number;
  logger?: boolean;
}

/**
 * Builds (but does not start listening on) the ingestion API's Fastify
 * instance. Kept separate from a `listen()` entrypoint so tests can drive it
 * in-process via `fastify.inject()` — no real socket, no port conflicts,
 * fully deterministic.
 *
 * Day 2 scope: an accepted (non-duplicate, non-conflicting) event is applied
 * synchronously, in-request, to the `SlidingWindowAggregator` — deliberately
 * not queued for later, periodic materialization (a literal reading of the
 * spec's "aggregator periodically materializes... totals"). Flagged
 * explicitly in the implementation log as a deviation: synchronous
 * application means the query API always reflects every accepted event with
 * no aggregation lag by construction, which is a real, citable design point
 * for the Day 4/5 "aggregation lag" benchmark, not an oversight. There is
 * still no durable event log yet (Day 3) — a process restart loses
 * in-memory aggregate state.
 */
export function buildServer(options: BuildServerOptions): FastifyInstance {
  const dedupStore = new DedupStore(options.dedupWindowMs, options.clock);
  const aggregator = new SlidingWindowAggregator({ bucketSizeMs: options.bucketSizeMs });

  const app = Fastify({ logger: options.logger ?? false });

  app.get("/health", async () => ({ status: "ok" }));

  app.post<{ Body: UsageEvent }>(
    "/events",
    { schema: { body: usageEventSchema } },
    async (request, reply) => {
      const event = request.body;
      const hash = payloadHash(event);
      const outcome = dedupStore.check(event.tenantId, event.idempotencyKey, hash);

      switch (outcome) {
        case "new":
          aggregator.record(event);
          reply.code(202);
          return { status: "accepted" };
        case "duplicate":
          reply.code(200);
          return { status: "duplicate" };
        case "conflict":
          reply.code(409);
          return {
            status: "rejected",
            reason: "idempotency_key_conflict",
          };
      }
    },
  );

  app.get<{ Params: { tenantId: string }; Querystring: { metric?: string } }>(
    "/aggregates/:tenantId",
    async (request) => {
      const { tenantId } = request.params;
      const { metric } = request.query;

      if (metric !== undefined) {
        return { tenantId, totals: { [metric]: aggregator.totalFor(tenantId, metric) } };
      }
      return { tenantId, totals: aggregator.totalsForTenant(tenantId) };
    },
  );

  return app;
}
