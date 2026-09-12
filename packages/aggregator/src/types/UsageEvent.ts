/**
 * A single usage event submitted by a client for metered billing.
 *
 * `occurredAtMs` is the client-asserted time the usage happened (not receipt
 * time) — sliding-window aggregation (Day 2+) buckets on this field, which is
 * exactly what makes out-of-order delivery a real concern instead of a
 * hypothetical one.
 */
export interface UsageEvent {
  tenantId: string;
  idempotencyKey: string;
  metric: string;
  quantity: number;
  occurredAtMs: number;
}

/**
 * The JSON Schema Fastify validates incoming request bodies against. Kept in
 * the same file as the TS type so the two can't silently drift apart.
 */
export const usageEventSchema = {
  type: "object",
  required: ["tenantId", "idempotencyKey", "metric", "quantity", "occurredAtMs"],
  additionalProperties: false,
  properties: {
    tenantId: { type: "string", minLength: 1 },
    idempotencyKey: { type: "string", minLength: 1 },
    metric: { type: "string", minLength: 1 },
    quantity: { type: "number", exclusiveMinimum: 0 },
    occurredAtMs: { type: "integer", minimum: 0 },
  },
} as const;
