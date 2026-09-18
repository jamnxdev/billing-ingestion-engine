import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { usageEventSchema, SlidingWindowAggregator, type UsageEvent } from "@billing/aggregator";
import { DedupStore } from "../dedup/DedupStore.js";
import { payloadHash } from "../dedup/payloadHash.js";
import { TokenBucket } from "../ratelimit/TokenBucket.js";

export interface RateLimitOptions {
  /** Sustained requests/sec allowed per tenant. */
  requestsPerSecond: number;
  /** Maximum burst above the sustained rate, per tenant. */
  burstCapacity: number;
}

export interface BuildServerOptions {
  /** Bounded dedup window, in milliseconds. */
  dedupWindowMs: number;
  /** Aggregation bucket width, in milliseconds. */
  bucketSizeMs: number;
  /** apiKey -> tenantId. The only source of truth for "which tenant is this request?" once authenticated. */
  apiKeys: Record<string, string>;
  /** Per-tenant ingestion rate limit. */
  rateLimit: RateLimitOptions;
  /** Injectable clock, so dedup-window and rate-limit tests don't depend on real time. */
  clock?: () => number;
  logger?: boolean;
}

/**
 * Reads the `x-api-key` header and resolves it to a tenant, or `undefined`
 * if the header is missing or unrecognized. Deliberately re-derived from the
 * raw header in each hook that needs it, rather than stashed on the request
 * object via Fastify request decoration — for two hooks and a trivial map
 * lookup, re-reading the header is simpler and just as fast as the
 * decorate-and-type-augment ceremony would be.
 */
function resolveApiKeyTenant(
  request: FastifyRequest,
  apiKeys: Record<string, string>,
): string | undefined {
  const header = request.headers["x-api-key"];
  const apiKey = Array.isArray(header) ? header[0] : header;
  return apiKey === undefined ? undefined : apiKeys[apiKey];
}

/**
 * Builds (but does not start listening on) the ingestion API's Fastify
 * instance. Kept separate from a `listen()` entrypoint so tests can drive it
 * in-process via `fastify.inject()` — no real socket, no port conflicts,
 * fully deterministic.
 *
 * `POST /events` is authenticated (`x-api-key` header, mapped to a tenant via
 * `apiKeys`) and rate-limited per authenticated tenant — never per the
 * client-supplied `tenantId` in the body, which would be exploitable (a
 * misbehaving client could just claim a different tenant to dodge its own
 * limit). The authenticated tenant must also match the body's `tenantId`
 * exactly, or the request is rejected — closing the same cross-tenant
 * spoofing concern the spec's security considerations raise for idempotency
 * keys, extended to the tenant identity itself. `GET /aggregates/:tenantId`
 * is deliberately left unauthenticated for now — the spec's security text is
 * specifically scoped to "the ingestion endpoint"; read-side tenant
 * isolation for the query API is a known, flagged gap, not an oversight (see
 * the implementation log).
 *
 * An accepted (non-duplicate, non-conflicting) event is applied
 * synchronously, in-request, to the `SlidingWindowAggregator` — deliberately
 * not queued for later, periodic materialization (a literal reading of the
 * spec's "aggregator periodically materializes... totals"). The query API
 * always reflects every accepted event with no aggregation lag by
 * construction. There is still no durable event log — a process restart
 * loses in-memory aggregate state.
 */
export function buildServer(options: BuildServerOptions): FastifyInstance {
  const dedupStore = new DedupStore(options.dedupWindowMs, options.clock);
  const aggregator = new SlidingWindowAggregator({ bucketSizeMs: options.bucketSizeMs });
  const rateLimiter = new TokenBucket(
    options.rateLimit.burstCapacity,
    options.rateLimit.requestsPerSecond,
    options.clock,
  );

  const app = Fastify({ logger: options.logger ?? false });

  app.get("/health", async () => ({ status: "ok" }));

  app.post<{ Body: UsageEvent }>(
    "/events",
    {
      schema: { body: usageEventSchema },
      // Runs before Fastify's own body-schema validation — an unauthenticated
      // caller is rejected without ever learning whether its payload would
      // otherwise have been well-formed.
      preValidation: async (request: FastifyRequest, reply: FastifyReply) => {
        if (resolveApiKeyTenant(request, options.apiKeys) === undefined) {
          const header = request.headers["x-api-key"];
          return reply.code(401).send({
            status: "rejected",
            reason: header === undefined ? "missing_api_key" : "invalid_api_key",
          });
        }
      },
      // Runs after body validation — tenant-match needs the parsed body, and
      // rate-limiting only makes sense against an already-authenticated tenant.
      preHandler: async (request: FastifyRequest<{ Body: UsageEvent }>, reply: FastifyReply) => {
        const authenticatedTenantId = resolveApiKeyTenant(request, options.apiKeys)!; // preValidation already guaranteed this resolves
        if (authenticatedTenantId !== request.body.tenantId) {
          return reply.code(403).send({ status: "rejected", reason: "tenant_mismatch" });
        }
        if (!rateLimiter.tryConsume(authenticatedTenantId)) {
          reply.header(
            "Retry-After",
            Math.ceil(rateLimiter.secondsUntilNextToken(authenticatedTenantId)),
          );
          return reply.code(429).send({ status: "rejected", reason: "rate_limited" });
        }
      },
    },
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
