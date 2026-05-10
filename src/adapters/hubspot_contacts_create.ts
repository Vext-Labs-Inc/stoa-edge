/**
 * hubspot_contacts_create.ts — Sample adapter for:
 *   urn:stoa:cap:hubspot.contacts.create@2.3.1
 *
 * This adapter mocks the HubSpot Create Contact API call and returns a fake
 * contact ID. The hashing, state_delta, side_effects, and compensation fields
 * are computed correctly so the full Stoa/1 response envelope is valid.
 *
 * A real HubSpot integration would replace the mock section with:
 *   await fetch("https://api.hubapi.com/crm/v3/objects/contacts", { ... })
 *
 * See: https://developers.hubspot.com/docs/api/crm/contacts
 */

import { sha256Hex } from "../util/hash";
import { AdapterResult } from "./index";

export interface HubSpotContactCreateInput {
  email: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  phone?: string;
}

export interface HubSpotContactCreateOutput {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  company: string;
  created_at: string;
  portal_id: string;
}

export async function hubspotContactsCreate(
  input: Record<string, unknown>,
): Promise<AdapterResult> {
  // Validate required fields
  const parsed = input as Partial<HubSpotContactCreateInput>;
  if (!parsed.email || typeof parsed.email !== "string") {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message: "email is required and must be a string",
        remediation: {
          hint: "fix-input-and-retry",
          next_capability: undefined,
          retry_after_ms: null,
          compose_hint: null,
        },
      },
    };
  }

  // --- MOCK HubSpot API call ---
  // In production: replace with real fetch to api.hubapi.com
  const mockContactId = `hs_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const output: HubSpotContactCreateOutput = {
    id: mockContactId,
    email: parsed.email,
    first_name: (parsed.first_name as string) ?? "",
    last_name: (parsed.last_name as string) ?? "",
    company: (parsed.company as string) ?? "",
    created_at: now,
    portal_id: "mock_portal_12345",
  };
  // --- END MOCK ---

  const outputHash = await sha256Hex(output);
  const inputHash = await sha256Hex(input);

  return {
    ok: true,
    output: output as unknown as Record<string, unknown>,
    inputHash,
    outputHash,
    cost: {
      actual_cents: 6, // mock: 6¢ vendor API + 2¢ stoa runtime = 8¢ total
      breakdown: [
        { kind: "vendor.api", amount_cents: 6 },
        { kind: "stoa.runtime", amount_cents: 2 },
      ],
    },
    state_delta: {
      resource: `urn:stoa:res:hubspot.contact:${mockContactId}`,
      version: 1,
      etag: `W/"${outputHash.slice(7, 15)}"`, // first 8 hex chars of sha256
      changeset: [
        {
          op: "create",
          path: "/",
          value_hash: outputHash,
        },
      ],
    },
    side_effects: [
      {
        kind: "external.welcome_email_may_send",
        when: "T+60s",
        undo: "urn:stoa:cap:hubspot.contacts.suppress@2.3.1",
        undo_args: { id: mockContactId },
      },
    ],
    lineage: {
      consumed_resources: [],
      produced_resource: `urn:stoa:res:hubspot.contact:${mockContactId}`,
    },
    compensation: {
      on_undo: "urn:stoa:cap:hubspot.contacts.delete@2.3.1",
      key_path: "$.id",
      undo_key_value: mockContactId,
    },
  };
}
