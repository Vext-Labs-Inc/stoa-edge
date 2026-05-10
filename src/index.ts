/**
 * index.ts — Stoa Edge main Worker fetch handler.
 *
 * Routes:
 *   POST /v1/cap                         — Stoa/1 capability call
 *   GET  /.well-known/stoa.json          — Discovery document
 *   GET  /.well-known/stoa-edge/keys.json — Public key set for receipt verification
 *   GET  /v1/saga/:plan_id/state         — Saga state (for debugging / conformance)
 *   POST /v1/saga/:plan_id/compensate    — Trigger compensation plan
 *   GET  /v1/budget/:agent_id/status     — Budget status
 *
 * Architecture:
 *   - Stateless worker (this file)
 *   - SagaDO  — one per plan_id, holds step checkpoints + compensation plan
 *   - BudgetDO — one per agent_id, enforces cost ceiling
 */

import { StoaRequestSchema } from "./wire";
import { verifyAgentJwt } from "./identity";
import { handleCap } from "./handlers/cap";
import { getPublicKeyJwks } from "./receipts";
import { listCapabilities } from "./adapters/index";
import { SagaDO } from "./durable_objects/saga";
import { BudgetDO } from "./durable_objects/budget";

// Re-export DOs so wrangler can find them
export { SagaDO, BudgetDO };

// ---------------------------------------------------------------------------
// Worker environment bindings (matches wrangler.toml)
// ---------------------------------------------------------------------------

export interface Env {
  SAGA_DO: DurableObjectNamespace;
  BUDGET_DO: DurableObjectNamespace;
  STOA_VERSION: string;
  RUNTIME_VERSION: string;
  RECEIPT_PRIVATE_KEY_JWK?: string;
  RECEIPT_PUBLIC_KEY_JWK?: string;
  VENDOR_DID?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Stoa-Runtime": "stoa-edge/0.1.0",
    },
  });
}

function stoaError(
  code: string,
  message: string,
  hint: string,
  httpStatus: number,
): Response {
  return json(
    {
      stoa: "1",
      status: "error",
      error: {
        code,
        message,
        remediation: { hint, next_capability: null, retry_after_ms: null },
      },
    },
    httpStatus,
  );
}

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, Acting-As",
        },
      });
    }

    // -----------------------------------------------------------------------
    // GET /.well-known/stoa.json — Discovery document
    // -----------------------------------------------------------------------
    if (request.method === "GET" && pathname === "/.well-known/stoa.json") {
      return json({
        spec_version: "stoa-0.1",
        vendor: {
          name: "Stoa Edge Reference Runtime",
          homepage: "https://github.com/Vext-Labs-Inc/stoa-edge",
          support_email: "stoa@vext.ai",
          verified: false,
        },
        manifest_url: `${url.origin}/v1/manifest`,
        auth: {
          kinds: ["agent-bearer"],
        },
        capabilities: listCapabilities(),
        rate_limits: {
          default_qps: 100,
          burst: 300,
        },
        conformance: {
          level: "core",
          spec: "https://github.com/Vext-Labs-Inc/stoa-spec",
        },
        runtime: {
          version: env.RUNTIME_VERSION ?? "0.1.0",
          vendor_did: env.VENDOR_DID ?? "did:web:stoa-edge.vext.ai",
          keys_url: `${url.origin}/.well-known/stoa-edge/keys.json`,
        },
      });
    }

    // -----------------------------------------------------------------------
    // GET /.well-known/stoa-edge/keys.json — Receipt verification public keys
    // -----------------------------------------------------------------------
    if (
      request.method === "GET" &&
      pathname === "/.well-known/stoa-edge/keys.json"
    ) {
      const jwks = await getPublicKeyJwks(env.RECEIPT_PUBLIC_KEY_JWK);
      return json(jwks);
    }

    // -----------------------------------------------------------------------
    // POST /v1/cap — Main Stoa/1 capability call
    // -----------------------------------------------------------------------
    if (request.method === "POST" && pathname === "/v1/cap") {
      // Parse body
      let rawBody: unknown;
      try {
        rawBody = await request.json();
      } catch {
        return stoaError(
          "validation_failed",
          "Request body must be valid JSON",
          "fix-input-and-retry",
          400,
        );
      }

      // Validate against Stoa/1 schema
      const parsed = StoaRequestSchema.safeParse(rawBody);
      if (!parsed.success) {
        return stoaError(
          "validation_failed",
          `Request envelope validation failed: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          "fix-input-and-retry",
          400,
        );
      }

      const stoaReq = parsed.data;

      // Verify agent identity (stub — logs issuer, checks JWT shape)
      const identity = await verifyAgentJwt(stoaReq.agent.jwt, stoaReq.agent.issuer);
      if (!identity.ok) {
        return stoaError(identity.code, identity.message, "auth-refresh", 401);
      }

      // Budget check — charge ceiling before running adapter
      if (stoaReq.budget) {
        const budgetId = env.BUDGET_DO.idFromName(identity.identity.sub);
        const budgetStub = env.BUDGET_DO.get(budgetId);

        // Estimate cost — adapters declare their cost; we use ceiling as the estimate for pre-check.
        // A real implementation would look up the cap's price oracle first.
        const preCheckResponse = await budgetStub.fetch(
          new Request("http://budget-do/charge", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              idem: `pre:${stoaReq.idem}`,
              cap: stoaReq.cap,
              amount_cents: 0, // zero-cent pre-check: just ensure ceiling is set
              ceiling_cents: stoaReq.budget.ceiling_cents,
              currency: stoaReq.budget.currency,
            }),
          }),
        );

        if (!preCheckResponse.ok) {
          const budgetError = await preCheckResponse.json() as { message?: string };
          return stoaError(
            "cost_limit_exceeded",
            budgetError.message ?? "Budget ceiling exceeded",
            "escalate-to-user",
            402,
          );
        }
      }

      // Idempotency check via Saga DO
      const sagaId = env.SAGA_DO.idFromName(stoaReq.trace.plan);
      const sagaStub = env.SAGA_DO.get(sagaId);

      const existingCheckpoint = await sagaStub.fetch(
        new Request(
          `http://saga-do/checkpoint/${encodeURIComponent(stoaReq.idem)}`,
          { method: "GET" },
        ),
      );

      if (existingCheckpoint.status === 200) {
        // Idempotent replay — return the stored receipt
        const checkpoint = await existingCheckpoint.json() as {
          receipt: unknown;
          cap: string;
        };
        return json({
          stoa: "1",
          status: "ok",
          receipt: checkpoint.receipt,
          output: null,
          _replay: true, // advisory: this is a replayed response
        });
      }

      // Run the capability
      const { response, httpStatus } = await handleCap(stoaReq, {
        RECEIPT_PRIVATE_KEY_JWK: env.RECEIPT_PRIVATE_KEY_JWK,
        VENDOR_DID: env.VENDOR_DID,
      });

      // On success, record the checkpoint in the Saga DO
      if (response.status === "ok" && response.receipt) {
        await sagaStub.fetch(
          new Request("http://saga-do/checkpoint", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              idem: stoaReq.idem,
              cap: stoaReq.cap,
              receipt: response.receipt,
              compensation: stoaReq.compensation
                ? {
                    on_undo: stoaReq.compensation.on_undo,
                    key_path: stoaReq.compensation.key_path,
                  }
                : undefined,
              recorded_at: Date.now(),
            }),
          }),
        );

        // Charge the actual cost (deduct from budget)
        if (stoaReq.budget && response.cost) {
          const budgetId = env.BUDGET_DO.idFromName(identity.identity.sub);
          const budgetStub = env.BUDGET_DO.get(budgetId);
          await budgetStub.fetch(
            new Request("http://budget-do/charge", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                idem: stoaReq.idem,
                cap: stoaReq.cap,
                amount_cents: response.cost.actual_cents,
                ceiling_cents: stoaReq.budget.ceiling_cents,
                currency: stoaReq.budget.currency,
              }),
            }),
          );
        }
      }

      return json(response, httpStatus);
    }

    // -----------------------------------------------------------------------
    // GET /v1/saga/:plan_id/state
    // -----------------------------------------------------------------------
    if (request.method === "GET" && pathname.startsWith("/v1/saga/")) {
      const parts = pathname.split("/");
      // /v1/saga/<plan_id>/state
      const planId = parts[3];
      const action = parts[4];
      if (!planId || action !== "state") {
        return stoaError("not_found", "Unknown saga endpoint", "permanent-failure", 404);
      }
      const sagaId = env.SAGA_DO.idFromName(planId);
      const sagaStub = env.SAGA_DO.get(sagaId);
      const stateResp = await sagaStub.fetch(
        new Request("http://saga-do/state", { method: "GET" }),
      );
      return new Response(stateResp.body, {
        status: stateResp.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    // -----------------------------------------------------------------------
    // POST /v1/saga/:plan_id/compensate
    // -----------------------------------------------------------------------
    if (request.method === "POST" && pathname.startsWith("/v1/saga/")) {
      const parts = pathname.split("/");
      const planId = parts[3];
      const action = parts[4];
      if (!planId || action !== "compensate") {
        return stoaError("not_found", "Unknown saga endpoint", "permanent-failure", 404);
      }
      const sagaId = env.SAGA_DO.idFromName(planId);
      const sagaStub = env.SAGA_DO.get(sagaId);
      const compResp = await sagaStub.fetch(
        new Request("http://saga-do/compensate", { method: "POST" }),
      );
      return new Response(compResp.body, {
        status: compResp.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    // -----------------------------------------------------------------------
    // GET /v1/budget/:agent_id/status
    // -----------------------------------------------------------------------
    if (request.method === "GET" && pathname.startsWith("/v1/budget/")) {
      const parts = pathname.split("/");
      const agentId = parts[3];
      const action = parts[4];
      if (!agentId || action !== "status") {
        return stoaError("not_found", "Unknown budget endpoint", "permanent-failure", 404);
      }
      const budgetId = env.BUDGET_DO.idFromName(agentId);
      const budgetStub = env.BUDGET_DO.get(budgetId);
      const statusResp = await budgetStub.fetch(
        new Request("http://budget-do/status", { method: "GET" }),
      );
      return new Response(statusResp.body, {
        status: statusResp.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    // -----------------------------------------------------------------------
    // 404 fallthrough
    // -----------------------------------------------------------------------
    return stoaError(
      "not_found",
      `No route matched: ${request.method} ${pathname}`,
      "permanent-failure",
      404,
    );
  },
};
