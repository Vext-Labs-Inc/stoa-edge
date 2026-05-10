/**
 * wire.test.ts — Vitest smoke test for the Stoa Edge reference runtime.
 *
 * Tests:
 *   1. StoaRequest envelope validation (valid + invalid shapes)
 *   2. StoaResponse envelope validation
 *   3. Mock adapter end-to-end: hubspot.contacts.create
 *   4. Receipt issuance + shape verification
 *   5. Idempotency key uniqueness (same idem → same output shape)
 *   6. Capability not found → typed error envelope
 *
 * Note: These tests run against the adapter and handler functions directly,
 * not through the full Worker fetch() (which requires the CF Workers test pool
 * or wrangler dev). Full integration tests are in tests/integration/.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { StoaRequestSchema, StoaResponseSchema } from "../src/wire";
import { hubspotContactsCreate } from "../src/adapters/hubspot_contacts_create";
import { lookupAdapter } from "../src/adapters/index";
import { issueReceipt, verifyReceipt } from "../src/receipts";
import { sha256Hex } from "../src/util/hash";
import { buildTestJwt } from "../src/identity";
import { handleCap } from "../src/handlers/cap";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildValidRequest(overrides: Record<string, unknown> = {}): unknown {
  return {
    stoa: "1",
    cap: "urn:stoa:cap:hubspot.contacts.create@2.3.1",
    idem: "agent_test:plan_001:step_1",
    agent: {
      jwt: buildTestJwt({ sub: "agent_test", iss: "did:web:hive.vext.ai" }),
      issuer: "did:web:hive.vext.ai",
      reputation_hint: "vext-hive:tier-3",
    },
    trace: {
      parent: "01HW8K",
      plan: "plan_001",
      step: 1,
    },
    budget: {
      ceiling_cents: 50,
      currency: "USD",
    },
    privacy: {
      input_classes: ["PII.email", "PII.name"],
      output_classes: ["PII.email", "INTERNAL.id"],
      jurisdiction: "US",
    },
    resume: null,
    input: {
      email: "ada@example.com",
      first_name: "Ada",
      last_name: "Lovelace",
      company: "Analytical Engines Ltd",
    },
    compensation: {
      on_undo: "urn:stoa:cap:hubspot.contacts.delete@2.3.1",
      key_path: "$.id",
    },
    policy: {
      require_human_confirmation: false,
      max_retry: 3,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Request envelope validation
// ---------------------------------------------------------------------------

describe("StoaRequestSchema", () => {
  it("accepts a valid full request envelope", () => {
    const result = StoaRequestSchema.safeParse(buildValidRequest());
    expect(result.success).toBe(true);
  });

  it("rejects a request with invalid stoa version", () => {
    const result = StoaRequestSchema.safeParse(
      buildValidRequest({ stoa: "2" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a cap URN without the urn:stoa:cap: prefix", () => {
    const result = StoaRequestSchema.safeParse(
      buildValidRequest({ cap: "hubspot.contacts.create" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a request with empty idem key", () => {
    const result = StoaRequestSchema.safeParse(buildValidRequest({ idem: "" }));
    expect(result.success).toBe(false);
  });

  it("accepts a request with minimal required fields", () => {
    const minimal = {
      stoa: "1",
      cap: "urn:stoa:cap:hubspot.contacts.create@2.3.1",
      idem: "test-idem-key",
      agent: {
        jwt: "eyJ.stub.sig",
        issuer: "did:web:hive.vext.ai",
      },
      trace: { plan: "plan_001", step: 0 },
      input: {},
    };
    const result = StoaRequestSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Adapter: hubspot.contacts.create
// ---------------------------------------------------------------------------

describe("hubspotContactsCreate adapter", () => {
  it("returns ok=true for valid input", async () => {
    const result = await hubspotContactsCreate({
      email: "ada@example.com",
      first_name: "Ada",
      last_name: "Lovelace",
    });
    expect(result.ok).toBe(true);
  });

  it("returns a contact id in output", async () => {
    const result = await hubspotContactsCreate({ email: "alan@example.com" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.output["id"]).toBe("string");
      expect((result.output["id"] as string).startsWith("hs_mock_")).toBe(true);
    }
  });

  it("returns a state_delta with correct resource URN", async () => {
    const result = await hubspotContactsCreate({ email: "grace@example.com" });
    expect(result.ok).toBe(true);
    if (result.ok && result.state_delta) {
      expect(result.state_delta.resource).toMatch(/^urn:stoa:res:hubspot\.contact:/);
      expect(result.state_delta.changeset[0]?.op).toBe("create");
    }
  });

  it("returns ok=false for missing email", async () => {
    const result = await hubspotContactsCreate({ first_name: "Ada" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation_failed");
      expect(result.error.remediation.hint).toBe("fix-input-and-retry");
    }
  });

  it("declares compensation metadata", async () => {
    const result = await hubspotContactsCreate({ email: "comp@example.com" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.compensation?.on_undo).toBe(
        "urn:stoa:cap:hubspot.contacts.delete@2.3.1",
      );
      expect(result.compensation?.key_path).toBe("$.id");
      expect(result.compensation?.undo_key_value).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Adapter registry
// ---------------------------------------------------------------------------

describe("adapter registry", () => {
  it("resolves versioned URN", () => {
    const fn = lookupAdapter(
      "urn:stoa:cap:hubspot.contacts.create@2.3.1",
    );
    expect(fn).toBeTruthy();
  });

  it("resolves version-less URN via fallback", () => {
    const fn = lookupAdapter("urn:stoa:cap:hubspot.contacts.create");
    expect(fn).toBeTruthy();
  });

  it("returns null for unknown capability", () => {
    const fn = lookupAdapter("urn:stoa:cap:stripe.charges.create@1.0.0");
    expect(fn).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Receipt issuance + signature shape
// ---------------------------------------------------------------------------

describe("receipt issuance", () => {
  let privateKeyJwkJson: string;
  let publicKeyJwkJson: string;

  beforeAll(async () => {
    // Generate a fresh keypair for tests
    const { privateKey, publicKey } = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );

    const { exportJWK } = await import("jose");
    const privJwk = await exportJWK(privateKey);
    const pubJwk = await exportJWK(publicKey);
    privateKeyJwkJson = JSON.stringify(privJwk);
    publicKeyJwkJson = JSON.stringify(pubJwk);
  });

  it("issues a receipt with correct fields", async () => {
    const inputHash = await sha256Hex({ email: "test@example.com" });
    const outputHash = await sha256Hex({ id: "hs_mock_123" });

    const receipt = await issueReceipt(
      {
        cap: "urn:stoa:cap:hubspot.contacts.create@2.3.1",
        agent_sub: "agent_test",
        ts: Math.floor(Date.now() / 1000),
        cost_cents: 8,
        input_hash: inputHash,
        output_hash: outputHash,
      },
      privateKeyJwkJson,
      "did:web:stoa-edge.vext.ai",
    );

    expect(receipt.alg).toBe("ES256");
    expect(receipt.sig).toBeTruthy();
    expect(typeof receipt.sig).toBe("string");
    // JWS Compact: header.payload.signature (3 parts separated by dots)
    expect(receipt.sig.split(".").length).toBe(3);
    expect(receipt.vendor_did).toBe("did:web:stoa-edge.vext.ai");
    expect(receipt.input_hash).toBe(inputHash);
    expect(receipt.output_hash).toBe(outputHash);
  });

  it("verifies a receipt against the public key", async () => {
    const inputHash = await sha256Hex({ email: "verify@example.com" });
    const outputHash = await sha256Hex({ id: "hs_mock_456" });
    const ts = Math.floor(Date.now() / 1000);

    const receipt = await issueReceipt(
      {
        cap: "urn:stoa:cap:hubspot.contacts.create@2.3.1",
        agent_sub: "agent_test",
        ts,
        cost_cents: 6,
        input_hash: inputHash,
        output_hash: outputHash,
      },
      privateKeyJwkJson,
      "did:web:stoa-edge.vext.ai",
    );

    const { valid, payload } = await verifyReceipt(receipt, publicKeyJwkJson);
    expect(valid).toBe(true);
    expect(payload?.cap).toBe("urn:stoa:cap:hubspot.contacts.create@2.3.1");
    expect(payload?.cost_cents).toBe(6);
    expect(payload?.ts).toBe(ts);
  });

  it("rejects a tampered receipt", async () => {
    const inputHash = await sha256Hex({ email: "tamper@example.com" });
    const outputHash = await sha256Hex({ id: "hs_mock_789" });

    const receipt = await issueReceipt(
      {
        cap: "urn:stoa:cap:hubspot.contacts.create@2.3.1",
        agent_sub: "agent_test",
        ts: Math.floor(Date.now() / 1000),
        cost_cents: 0,
        input_hash: inputHash,
        output_hash: outputHash,
      },
      privateKeyJwkJson,
      "did:web:stoa-edge.vext.ai",
    );

    // Tamper with the signature
    const parts = receipt.sig.split(".");
    parts[2] = parts[2]!.split("").reverse().join(""); // corrupt the sig
    const tamperedReceipt = { ...receipt, sig: parts.join(".") };

    const { valid } = await verifyReceipt(tamperedReceipt, publicKeyJwkJson);
    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. handleCap — full end-to-end (no DO, no network)
// ---------------------------------------------------------------------------

describe("handleCap", () => {
  it("returns ok response for valid hubspot.contacts.create request", async () => {
    const parsed = StoaRequestSchema.parse(buildValidRequest());
    const { response, httpStatus } = await handleCap(parsed, {
      VENDOR_DID: "did:web:stoa-edge.vext.ai",
    });

    expect(httpStatus).toBe(200);
    expect(response.stoa).toBe("1");
    expect(response.status).toBe("ok");
    expect(response.receipt).toBeTruthy();
    expect(response.receipt.alg).toBe("ES256");
    expect(response.output).toBeTruthy();
    expect(typeof (response.output as Record<string, unknown>)["id"]).toBe("string");
  });

  it("validates the response envelope against StoaResponseSchema", async () => {
    const parsed = StoaRequestSchema.parse(buildValidRequest());
    const { response } = await handleCap(parsed, {
      VENDOR_DID: "did:web:stoa-edge.vext.ai",
    });
    const validated = StoaResponseSchema.safeParse(response);
    expect(validated.success).toBe(true);
  });

  it("returns typed error for unknown capability", async () => {
    const parsed = StoaRequestSchema.parse(
      buildValidRequest({ cap: "urn:stoa:cap:unknown.capability@1.0.0" }),
    );
    const { response, httpStatus } = await handleCap(parsed, {});
    expect(httpStatus).toBe(404);
    expect(response.status).toBe("error");
    expect(response.error?.code).toBe("not_found");
    expect(response.error?.remediation.hint).toBe("permanent-failure");
    // Even errors get a receipt
    expect(response.receipt).toBeTruthy();
  });

  it("returns typed error for missing email", async () => {
    const parsed = StoaRequestSchema.parse(
      buildValidRequest({ input: { first_name: "Ada" } }),
    );
    const { response, httpStatus } = await handleCap(parsed, {});
    expect(httpStatus).toBe(422);
    expect(response.status).toBe("error");
    expect(response.error?.code).toBe("validation_failed");
    expect(response.error?.remediation.hint).toBe("fix-input-and-retry");
  });
});

// ---------------------------------------------------------------------------
// 6. Hash utility
// ---------------------------------------------------------------------------

describe("sha256Hex", () => {
  it("returns a stable hash for the same input", async () => {
    const h1 = await sha256Hex({ a: 1, b: 2 });
    const h2 = await sha256Hex({ b: 2, a: 1 }); // different key order
    expect(h1).toBe(h2); // stable stringify
  });

  it("returns different hashes for different inputs", async () => {
    const h1 = await sha256Hex({ email: "a@example.com" });
    const h2 = await sha256Hex({ email: "b@example.com" });
    expect(h1).not.toBe(h2);
  });

  it("starts with sha256:", async () => {
    const h = await sha256Hex({ test: true });
    expect(h.startsWith("sha256:")).toBe(true);
  });
});
