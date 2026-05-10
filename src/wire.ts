/**
 * wire.ts — Zod schemas and TypeScript types for the Stoa/1 request and response envelopes.
 * Implements §5.1 (request) and §5.2 (response) from STOA.md.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// §5.1 — Request envelope
// ---------------------------------------------------------------------------

export const AgentSchema = z.object({
  jwt: z.string(),
  issuer: z.string(), // DID of the issuing hive, e.g. "did:web:hive.vext.ai"
  reputation_hint: z.string().optional(),
});

export const TraceSchema = z.object({
  parent: z.string().optional(), // W3C Trace Context parent
  plan: z.string(),
  step: z.number().int().nonnegative(),
});

export const BudgetSchema = z.object({
  ceiling_cents: z.number().int().positive(),
  currency: z.string().default("USD"),
  settlement: z.string().optional(), // e.g. "x402-escrow:0xab..."
});

export const PrivacySchema = z.object({
  // TODO(v0.2): enforce routing based on input/output privacy classes
  input_classes: z.array(z.string()).optional(),
  output_classes: z.array(z.string()).optional(),
  jurisdiction: z.string().optional(), // ISO 3166-1 alpha-2 country code or region
});

export const CompensationSchema = z.object({
  on_undo: z.string(), // URN of the compensating capability
  key_path: z.string(), // JSONPath into output to extract the key, e.g. "$.id"
});

export const PolicySchema = z.object({
  require_human_confirmation: z.boolean().default(false),
  max_retry: z.number().int().nonnegative().default(3),
  preferred_region: z.string().optional(),
});

export const StoaRequestSchema = z.object({
  stoa: z.literal("1"),
  cap: z.string().regex(/^urn:stoa:cap:/, "cap must be a urn:stoa:cap: URN"),
  idem: z.string().min(1), // idempotency key — persisted by Saga DO
  agent: AgentSchema,
  trace: TraceSchema,
  budget: BudgetSchema.optional(),
  privacy: PrivacySchema.optional(),
  resume: z.string().nullable().optional(), // continuation token for resuming
  input: z.record(z.unknown()), // typed by capability schema; validated by adapter
  compensation: CompensationSchema.optional(),
  policy: PolicySchema.optional(),
});

export type StoaRequest = z.infer<typeof StoaRequestSchema>;

// ---------------------------------------------------------------------------
// §5.2 — Response envelope
// ---------------------------------------------------------------------------

export const ReceiptSchema = z.object({
  alg: z.enum(["ES256", "EdDSA"]),
  sig: z.string(), // JWS Compact Serialization or detached sig
  vendor_did: z.string(),
  merkle_root: z.string().optional(),
  merkle_proof: z.string().optional(),
  ts: z.number().int(), // Unix timestamp seconds
  input_hash: z.string(), // "sha256:<hex>"
  output_hash: z.string(),
  state_delta_hash: z.string().optional(),
});

export const StateDeltaChangesetEntrySchema = z.object({
  op: z.enum(["create", "update", "delete", "patch"]),
  path: z.string(),
  value_hash: z.string().optional(),
});

export const StateDeltaSchema = z.object({
  resource: z.string(), // "urn:stoa:res:<vendor>.<type>:<id>"
  version: z.number().int().nonnegative(),
  etag: z.string().optional(),
  changeset: z.array(StateDeltaChangesetEntrySchema),
});

export const CostBreakdownEntrySchema = z.object({
  kind: z.string(), // e.g. "vendor.api", "stoa.runtime"
  amount_cents: z.number().int().nonnegative(),
});

export const CostSchema = z.object({
  actual_cents: z.number().int().nonnegative(),
  breakdown: z.array(CostBreakdownEntrySchema),
  settlement_ref: z.string().optional(),
});

export const SideEffectSchema = z.object({
  kind: z.string(), // e.g. "external.email_will_send"
  when: z.string().optional(), // relative time hint, e.g. "T+30s"
  undo: z.string().optional(), // compensating cap URN
  undo_args: z.record(z.unknown()).optional(),
});

export const WarningSchema = z.object({
  code: z.string(),
  field: z.string().optional(),
  removal: z.string().optional(), // ISO date for deprecation
  message: z.string().optional(),
});

export const LineageSchema = z.object({
  consumed_resources: z.array(z.string()),
  produced_resource: z.string().optional(),
});

export const StoaResponseSchema = z.object({
  stoa: z.literal("1"),
  status: z.enum(["ok", "error", "partial"]),
  receipt: ReceiptSchema,
  state_delta: StateDeltaSchema.optional(),
  continuation: z.string().nullable().optional(),
  cost: CostSchema.optional(),
  side_effects: z.array(SideEffectSchema).optional(),
  warnings: z.array(WarningSchema).optional(),
  lineage: LineageSchema.optional(),
  output: z.record(z.unknown()).optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      remediation: z.object({
        hint: z.string(),
        next_capability: z.string().optional(),
        retry_after_ms: z.number().nullable().optional(),
        compose_hint: z.string().nullable().optional(),
      }),
      trace_id: z.string().optional(),
      details: z.record(z.unknown()).optional(),
    })
    .optional(),
});

export type Receipt = z.infer<typeof ReceiptSchema>;
export type StateDelta = z.infer<typeof StateDeltaSchema>;
export type StoaResponse = z.infer<typeof StoaResponseSchema>;
export type Cost = z.infer<typeof CostSchema>;
export type SideEffect = z.infer<typeof SideEffectSchema>;
