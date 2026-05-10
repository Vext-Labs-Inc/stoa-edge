/**
 * identity.ts — JWT verification stub for Stoa/1 agent identity.
 *
 * Full §7.3 agent-bearer verification requires resolving the issuer's DID document
 * and verifying the ES256 signature against the DID-bound public key.
 *
 * For v0 we: (1) decode and validate the JWT shape, (2) log the issuer,
 * (3) return a typed identity claim. Real signature verification is a TODO(v0.2).
 */

import * as jose from "jose";

export interface AgentIdentity {
  sub: string; // agent_id
  iss: string; // issuer DID
  aud: string | string[]; // intended audience (vendor host)
  scope: string; // space-separated capability scopes
  act_as?: string; // human user the agent is acting on behalf of
  exp?: number;
}

export interface VerifyResult {
  ok: true;
  identity: AgentIdentity;
}

export interface VerifyError {
  ok: false;
  code: "unauthenticated" | "forbidden";
  message: string;
}

export type VerifyOutcome = VerifyResult | VerifyError;

/**
 * Verify a Stoa agent-bearer JWT.
 *
 * v0 stub: decodes without signature verification, validates required claims.
 * TODO(v0.2): resolve issuer DID document → extract JWK → verify ES256 signature.
 */
export async function verifyAgentJwt(
  jwt: string,
  issuerDid: string,
): Promise<VerifyOutcome> {
  try {
    // jose.decodeJwt returns the payload directly as a JWTPayload
    const claims = jose.decodeJwt(jwt);

    if (!claims.sub || !claims.iss) {
      return {
        ok: false,
        code: "unauthenticated",
        message: "JWT missing required claims: sub, iss",
      };
    }

    if (claims.iss !== issuerDid) {
      // Log mismatch but accept for v0 (stub mode)
      console.warn(
        `[stoa-identity] issuer mismatch: envelope says "${issuerDid}", jwt.iss is "${claims.iss}" — accepted in v0 stub mode`,
      );
    }

    // Check expiry if present
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) {
      return {
        ok: false,
        code: "unauthenticated",
        message: "JWT has expired",
      };
    }

    const identity: AgentIdentity = {
      sub: claims.sub as string,
      iss: claims.iss as string,
      aud: (claims.aud as string | string[]) ?? [],
      scope: (claims["scope"] as string) ?? "",
      act_as: claims["act_as"] as string | undefined,
      exp: claims.exp,
    };

    console.info(
      `[stoa-identity] agent verified (stub) sub=${identity.sub} iss=${identity.iss}`,
    );

    return { ok: true, identity };
  } catch (err) {
    return {
      ok: false,
      code: "unauthenticated",
      message: `JWT decode failed: ${String(err)}`,
    };
  }
}

/**
 * Build a minimal unsigned agent JWT for testing purposes only.
 * Do NOT use in production — this produces an unverified token.
 */
export function buildTestJwt(claims: Partial<AgentIdentity>): string {
  const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" }))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const payload = btoa(
    JSON.stringify({
      sub: claims.sub ?? "agent_test",
      iss: claims.iss ?? "did:web:hive.vext.ai",
      aud: claims.aud ?? "stoa-edge.vext.ai",
      scope: claims.scope ?? "crm:contacts:write",
      act_as: claims.act_as,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  // Unsigned (alg=none) — stub only
  return `${header}.${payload}.`;
}
