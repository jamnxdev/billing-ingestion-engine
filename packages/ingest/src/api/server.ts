import Fastify, { type FastifyInstance } from "fastify";
import { usageEventSchema, type UsageEvent } from "../types/UsageEvent.js";
import { DedupStore } from "../dedup/DedupStore.js";
import { payloadHash } from "../dedup/payloadHash.js";

export interface BuildServerOptions {
  /** Bounded dedup window, in milliseconds. */
  dedupWindowMs: number;
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
 * Day 1 scope: validate the event shape at the boundary, then run it through
 * the idempotency dedup check. There is deliberately no aggregation or
 * durable log wiring yet — the ingestion API's contract ("accepted" /
 * "duplicate" / rejected-as-conflict) is what Day 1 is proving; Day 2+ adds
 * what happens to an accepted event after this boundary.
 */
export function buildServer(options: BuildServerOptions): FastifyInstance {
  const dedupStore = new DedupStore(options.dedupWindowMs, options.clock);

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

  return app;
}
