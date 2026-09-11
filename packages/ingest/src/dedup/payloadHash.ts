import { createHash } from "node:crypto";
import type { UsageEvent } from "../types/UsageEvent.js";

/**
 * Hashes the business fields of an event (everything except the idempotency
 * key itself) so the dedup store can distinguish "the same event submitted
 * twice" from "a different event that happened to reuse the same key" — the
 * latter is a client bug, not a legitimate retry, and must not be silently
 * absorbed as a no-op duplicate.
 */
export function payloadHash(event: UsageEvent): string {
  const canonical = JSON.stringify({
    tenantId: event.tenantId,
    metric: event.metric,
    quantity: event.quantity,
    occurredAtMs: event.occurredAtMs,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
