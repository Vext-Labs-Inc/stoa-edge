/**
 * receipts.ts — ES256 signed-receipt issuance for Stoa/1 responses.
 *
 * Each capability call produces a signed receipt over:
 *   { cap, agent_sub, ts, cost_cents, input_hash, output_hash, state_delta_hash }
 *
 * The receipt is a JWS Compact Serialization (header.payload.sig) using ES256.
 *
 * Key management:
 *   - On first call the worker generates a P-256 keypair, stores it in the DO environment.
 *   - Callers can fetch the public key at /.well-known/stoa-edge/keys.json.
 *   - For v0, the key is stored in an environment variable (RECEIPT_PRIVATE_KEY_JWK /
 *     RECEIPT_PUBLIC_KEY_JWK). If absent, we generate an ephemeral in-memory key and
 *     log a warning — not suitable for production.
 */

import * as jose from "jose";
import { Receipt } from "./wire";

export interface ReceiptPayload {
  cap: string;
  agent_sub: string;
  ts: number; // Unix seconds
  cost_cents: number;
  input_hash: string;
  output_hash: string;
  state_delta_hash?: string;
}

// In-memory ephemeral key — only used when env vars are absent.
// Reset on every cold start; purely for development convenience.
let ephemeralPrivateKey: CryptoKey | null = null;
let ephemeralPublicKeyJwk: jose.JWK | null = null;

async function getOrCreateEphemeralKey(): Promise<{
  privateKey: CryptoKey;
  publicKeyJwk: jose.JWK;
}> {
  if (!ephemeralPrivateKey || !ephemeralPublicKeyJwk) {
    console.warn(
      "[stoa-receipts] No RECEIPT_PRIVATE_KEY_JWK in env — using ephemeral key. Do NOT use in production.",
    );
    const { privateKey, publicKey } = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    ephemeralPrivateKey = privateKey;
    ephemeralPublicKeyJwk = (await jose.exportJWK(publicKey)) as jose.JWK;
  }
  return {
    privateKey: ephemeralPrivateKey,
    publicKeyJwk: ephemeralPublicKeyJwk,
  };
}

/**
 * Import an ES256 signing key from a JWK JSON string.
 */
async function importPrivateKey(jwkJson: string): Promise<CryptoKey> {
  const jwk = JSON.parse(jwkJson) as jose.JWK;
  return (await jose.importJWK(jwk, "ES256")) as CryptoKey;
}

/**
 * Issue a signed Stoa/1 receipt.
 *
 * @param payload - the receipt claim set
 * @param privateKeyJwkJson - optional JWK JSON string; falls back to ephemeral key
 * @param vendorDid - the vendor's DID, included in the receipt
 */
export async function issueReceipt(
  payload: ReceiptPayload,
  privateKeyJwkJson: string | undefined,
  vendorDid: string,
): Promise<Receipt> {
  let signingKey: CryptoKey;
  let publicKeyJwk: jose.JWK;

  if (privateKeyJwkJson) {
    signingKey = await importPrivateKey(privateKeyJwkJson);
    // Derive public from private for the JWK endpoint
    // (The RECEIPT_PUBLIC_KEY_JWK env var is the canonical source)
    publicKeyJwk = {}; // not needed for issuance
  } else {
    const ephemeral = await getOrCreateEphemeralKey();
    signingKey = ephemeral.privateKey;
    publicKeyJwk = ephemeral.publicKeyJwk;
    void publicKeyJwk; // referenced below only for key endpoint
  }

  const jws = await new jose.CompactSign(
    new TextEncoder().encode(JSON.stringify(payload)),
  )
    .setProtectedHeader({ alg: "ES256", typ: "stoa-receipt+jwt" })
    .sign(signingKey);

  return {
    alg: "ES256",
    sig: jws,
    vendor_did: vendorDid,
    ts: payload.ts,
    input_hash: payload.input_hash,
    output_hash: payload.output_hash,
    state_delta_hash: payload.state_delta_hash,
    // merkle_root and merkle_proof are set by the daily anchoring job (v0.2)
  };
}

/**
 * Return the public JWK set for the /.well-known/stoa-edge/keys.json endpoint.
 */
export async function getPublicKeyJwks(
  publicKeyJwkJson: string | undefined,
): Promise<{ keys: jose.JWK[] }> {
  if (publicKeyJwkJson) {
    return { keys: [JSON.parse(publicKeyJwkJson) as jose.JWK] };
  }
  const { publicKeyJwk } = await getOrCreateEphemeralKey();
  return { keys: [publicKeyJwk] };
}

/**
 * Verify a receipt signature. Used by the conformance test suite and external auditors.
 */
export async function verifyReceipt(
  receipt: Receipt,
  publicKeyJwkJson: string,
): Promise<{ valid: boolean; payload: ReceiptPayload | null }> {
  try {
    const publicKey = await jose.importJWK(
      JSON.parse(publicKeyJwkJson) as jose.JWK,
      "ES256",
    );
    const { payload } = await jose.compactVerify(receipt.sig, publicKey);
    return {
      valid: true,
      payload: JSON.parse(new TextDecoder().decode(payload)) as ReceiptPayload,
    };
  } catch {
    return { valid: false, payload: null };
  }
}
