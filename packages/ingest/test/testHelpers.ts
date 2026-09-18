import type { FastifyInstance } from "fastify";
import type { UsageEvent } from "@billing/aggregator";

/** Test convention: an event's API key is always `key-<tenantId>` — trivially derivable, never guessed. */
export function apiKeyFor(tenantId: string): string {
  return `key-${tenantId}`;
}

export const TEST_TENANTS = ["tenant-a", "tenant-b", "tenant-bench"] as const;

export const TEST_API_KEYS: Record<string, string> = Object.fromEntries(
  TEST_TENANTS.map((tenantId) => [apiKeyFor(tenantId), tenantId]),
);

/** Effectively unlimited — most tests are about dedup/aggregation behavior, not rate limiting; the dedicated rate-limit tests configure their own tight limits explicitly. */
export const GENEROUS_RATE_LIMIT = { requestsPerSecond: 1_000_000, burstCapacity: 1_000_000 };

/**
 * POSTs an event with the correct `x-api-key` header for its own `tenantId`.
 * Pass `apiKeyOverride` to send a different (e.g. wrong-tenant or unknown)
 * key, or `null` to omit the header entirely — both for auth-failure tests.
 */
export function postEvent(
  app: FastifyInstance,
  event: UsageEvent,
  apiKeyOverride?: string | null,
) {
  return app.inject({
    method: "POST",
    url: "/events",
    headers:
      apiKeyOverride === null ? {} : { "x-api-key": apiKeyOverride ?? apiKeyFor(event.tenantId) },
    payload: event,
  });
}
