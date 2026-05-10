/**
 * adapters/index.ts — Registry of cap URN → adapter function.
 *
 * To add a new adapter:
 *   1. Create src/adapters/<vendor>_<resource>_<action>.ts
 *   2. Export an async function matching the AdapterFn signature
 *   3. Add the URN → function mapping to ADAPTER_REGISTRY below
 *
 * URN format: urn:stoa:cap:<domain>.<resource>.<action>@<semver>
 * Wildcards: a registry entry without @version matches all versions.
 */

import { StateDelta, SideEffect, Cost, LineageSchema } from "../wire";
import { z } from "zod";
import { hubspotContactsCreate } from "./hubspot_contacts_create";

// ---------------------------------------------------------------------------
// Adapter result type
// ---------------------------------------------------------------------------

export interface AdapterSuccess {
  ok: true;
  output: Record<string, unknown>;
  inputHash: string;
  outputHash: string;
  cost?: Cost;
  state_delta?: StateDelta;
  side_effects?: SideEffect[];
  lineage?: z.infer<typeof LineageSchema>;
  compensation?: {
    on_undo: string;
    key_path: string;
    undo_key_value?: string;
  };
}

export interface AdapterFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    remediation: {
      hint: string;
      next_capability?: string;
      retry_after_ms: number | null;
      compose_hint: string | null;
    };
    details?: Record<string, unknown>;
  };
}

export type AdapterResult = AdapterSuccess | AdapterFailure;

export type AdapterFn = (
  input: Record<string, unknown>,
) => Promise<AdapterResult>;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Maps canonical cap URNs (with version) to their adapter functions.
 * Also supports version-less fallback: "urn:stoa:cap:hubspot.contacts.create"
 * will match if the full versioned URN is not found.
 */
const ADAPTER_REGISTRY: Record<string, AdapterFn> = {
  "urn:stoa:cap:hubspot.contacts.create@2.3.1": hubspotContactsCreate,
  // Version-less fallback — matches any version of this capability
  "urn:stoa:cap:hubspot.contacts.create": hubspotContactsCreate,
};

/**
 * Look up an adapter by full versioned URN, then by base URN (without @version).
 * Returns null if no adapter is registered.
 */
export function lookupAdapter(capUrn: string): AdapterFn | null {
  if (ADAPTER_REGISTRY[capUrn]) {
    return ADAPTER_REGISTRY[capUrn] ?? null;
  }
  // Strip @version suffix and try base URN
  const baseUrn = capUrn.replace(/@[^@]+$/, "");
  return ADAPTER_REGISTRY[baseUrn] ?? null;
}

/**
 * List all registered cap URNs (for /.well-known/stoa.json discovery).
 */
export function listCapabilities(): string[] {
  return Object.keys(ADAPTER_REGISTRY);
}
