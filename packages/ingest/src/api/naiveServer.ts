import Fastify, { type FastifyInstance } from "fastify";
import { usageEventSchema, SlidingWindowAggregator, type UsageEvent } from "@billing/aggregator";

export interface BuildNaiveServerOptions {
  /** Aggregation bucket width, in milliseconds. */
  bucketSizeMs: number;
  logger?: boolean;
}

/**
 * The "trust the client, no dedup" baseline: validates and applies every
 * submitted event to the aggregator unconditionally, with no idempotency
 * check of any kind. This is deliberately the naive design an implementer
 * would reach for without thinking about retries/duplicates — not a
 * strawman, just `buildServer` minus its one defining feature — so the
 * correctness benchmark's naive-vs-correct comparison is a fair,
 * apples-to-apples measurement of exactly what the dedup layer buys.
 *
 * Same request/response shape as `buildServer` for "new" events (202
 * accepted) so the adversarial test client can point at either target
 * without caring which one it's talking to — except there is no
 * "duplicate" or "conflict" outcome here: every well-formed submission is
 * "accepted" and applied, including a byte-for-byte resubmission of an
 * event already applied moments ago.
 */
export function buildNaiveServer(options: BuildNaiveServerOptions): FastifyInstance {
  const aggregator = new SlidingWindowAggregator({ bucketSizeMs: options.bucketSizeMs });

  const app = Fastify({ logger: options.logger ?? false });

  app.get("/health", async () => ({ status: "ok" }));

  app.post<{ Body: UsageEvent }>(
    "/events",
    { schema: { body: usageEventSchema } },
    async (_request, reply) => {
      aggregator.record(_request.body);
      reply.code(202);
      return { status: "accepted" };
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
