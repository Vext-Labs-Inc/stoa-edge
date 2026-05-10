/**
 * handlers/cap.ts — Capability dispatcher.
 *
 * Receives a validated StoaRequest, looks up the adapter, runs it, and
 * assembles the full StoaResponse envelope including the signed receipt.
 */

import { StoaRequest, StoaResponse, Receipt } from "../wire";
import { lookupAdapter } from "../adapters/index";
import { issueReceipt } from "../receipts";
import { sha256Hex } from "../util/hash";

export interface CapHandlerEnv {
  RECEIPT_PRIVATE_KEY_JWK?: string;
  VENDOR_DID?: string;
}

/**
 * Dispatch a validated Stoa capability request to the registered adapter,
 * wrap the result in the full response envelope, and return it.
 */
export async function handleCap(
  req: StoaRequest,
  env: CapHandlerEnv,
): Promise<{ response: StoaResponse; httpStatus: number }> {
  const vendorDid = env.VENDOR_DID ?? "did:web:stoa-edge.vext.ai";

  const adapter = lookupAdapter(req.cap);
  if (!adapter) {
    const ts = Math.floor(Date.now() / 1000);
    const inputHash = await sha256Hex(req.input);
    const errPayload = { error: "capability_not_found" };
    const outputHash = await sha256Hex(errPayload);

    const receipt = await issueReceipt(
      {
        cap: req.cap,
        agent_sub: req.agent.jwt.slice(0, 16),
        ts,
        cost_cents: 0,
        input_hash: inputHash,
        output_hash: outputHash,
      },
      env.RECEIPT_PRIVATE_KEY_JWK,
      vendorDid,
    );

    const response: StoaResponse = {
      stoa: "1",
      status: "error",
      receipt,
      error: {
        code: "not_found",
        message: `No adapter registered for capability: ${req.cap}`,
        remediation: {
          hint: "permanent-failure",
          next_capability: undefined,
          retry_after_ms: null,
          compose_hint: null,
        },
        trace_id: req.trace.plan,
      },
    };
    return { response, httpStatus: 404 };
  }

  // Run the adapter
  const result = await adapter(req.input);
  const ts = Math.floor(Date.now() / 1000);
  const inputHash = await sha256Hex(req.input);

  if (!result.ok) {
    const outputHash = await sha256Hex({ error: result.error });
    const receipt = await issueReceipt(
      {
        cap: req.cap,
        agent_sub: req.agent.jwt.slice(0, 16),
        ts,
        cost_cents: 0,
        input_hash: inputHash,
        output_hash: outputHash,
      },
      env.RECEIPT_PRIVATE_KEY_JWK,
      vendorDid,
    );

    const response: StoaResponse = {
      stoa: "1",
      status: "error",
      receipt,
      error: {
        ...result.error,
        trace_id: req.trace.plan,
      },
    };
    return { response, httpStatus: 422 };
  }

  // Success path
  const stateDeltaHash = result.state_delta
    ? await sha256Hex(result.state_delta)
    : undefined;

  const receipt = await issueReceipt(
    {
      cap: req.cap,
      agent_sub: req.agent.sub ?? req.agent.jwt.slice(0, 16),
      ts,
      cost_cents: result.cost?.actual_cents ?? 0,
      input_hash: result.inputHash,
      output_hash: result.outputHash,
      state_delta_hash: stateDeltaHash,
    },
    env.RECEIPT_PRIVATE_KEY_JWK,
    vendorDid,
  );

  const response: StoaResponse = {
    stoa: "1",
    status: "ok",
    receipt,
    output: result.output,
    state_delta: result.state_delta,
    cost: result.cost,
    side_effects: result.side_effects,
    lineage: result.lineage,
    continuation: null,
  };

  return { response, httpStatus: 200 };
}
