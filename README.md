# stoa-edge

The reference runtime for [Stoa](https://github.com/Vext-Labs-Inc/stoa-spec) — the open substrate for agent-readable SaaS.

Stoa is the open standard, runtime, and federated registry that lets any agent call any SaaS as a typed, signed, idempotent, cost-governed, audit-trailed capability instead of clicking through a UI it was never meant to use. This repo is the Cloudflare Workers + Durable Objects runtime that handles one end-to-end Stoa/1 capability call with everything the spec demands: Saga checkpoints, Budget enforcement, ES256-signed receipts, and a sample HubSpot adapter.

Spec: https://github.com/Vext-Labs-Inc/stoa-spec
License: Apache-2.0

---

## Quickstart

```bash
npm install
npx wrangler dev       # local dev at http://localhost:8787
```

Send a capability call:

```bash
curl -X POST http://localhost:8787/v1/cap \
  -H "Content-Type: application/json" \
  -d '{
    "stoa": "1",
    "cap": "urn:stoa:cap:hubspot.contacts.create@2.3.1",
    "idem": "agent_1:plan_1:step_1",
    "agent": {
      "jwt": "<your-agent-bearer-jwt>",
      "issuer": "did:web:hive.vext.ai"
    },
    "trace": { "plan": "plan_1", "step": 1 },
    "budget": { "ceiling_cents": 50, "currency": "USD" },
    "input": { "email": "ada@example.com", "first_name": "Ada" }
  }'
```

Discover capabilities:

```bash
curl http://localhost:8787/.well-known/stoa.json
```

Fetch the receipt verification public key:

```bash
curl http://localhost:8787/.well-known/stoa-edge/keys.json
```

---

## Architecture

```
Agent  --POST /v1/cap-->  Edge Worker (stateless)
                               |
                    +----------+----------+
                    |                     |
               Saga DO               Budget DO
             (plan_id)              (agent_id)
          checkpoint store         cost ceiling
          compensation plan        per-call charge
                    |
               Receipt Log
            (ES256-signed JWS)
```

### Saga DO (src/durable_objects/saga.ts)

One Durable Object per `plan_id`. Persists `(idem_key -> receipt)` checkpoints so that:

- Retries on a different Worker instance return the prior receipt (exactly-once delivery).
- Partial-failure compensation can walk recorded steps in reverse and build a compensation plan.

Methods exposed over internal fetch:
- `POST /checkpoint` — record a step
- `GET /checkpoint/:idem` — idempotency lookup
- `GET /state` — full saga state
- `POST /compensate` — build reverse compensation plan

### Budget DO (src/durable_objects/budget.ts)

One Durable Object per `agent_id`. Enforces the `budget.ceiling_cents` declared in the Stoa/1 request envelope. Returns HTTP 402 shape on exceed.

Methods:
- `POST /charge` — attempt to charge; idempotent on idem key
- `GET /status` — current spend + available

### Receipt issuance (src/receipts.ts)

Every capability call — including errors — produces a signed receipt in JWS Compact Serialization (ES256). The receipt payload covers `(cap, agent_sub, ts, cost_cents, input_hash, output_hash, state_delta_hash)`.

The public key is served at `/.well-known/stoa-edge/keys.json` so any party can verify receipts offline.

Key management: set `RECEIPT_PRIVATE_KEY_JWK` and `RECEIPT_PUBLIC_KEY_JWK` as Wrangler secrets. If absent, the runtime generates an ephemeral in-memory key (development only — do not use in production).

### Identity verification (src/identity.ts)

v0 stub: decodes the agent-bearer JWT, validates required claims (`sub`, `iss`), checks expiry. Full DID document resolution + ES256 signature verification is TODO(v0.2).

---

## How to add an adapter

1. Create `src/adapters/<vendor>_<resource>_<action>.ts`
2. Export an async function with signature `(input: Record<string, unknown>) => Promise<AdapterResult>`
3. Register the cap URN in `ADAPTER_REGISTRY` in `src/adapters/index.ts`
4. Add tests in `tests/`

The sample adapter at `src/adapters/hubspot_contacts_create.ts` is the canonical reference. It mocks the HubSpot API call but computes all hashes, state deltas, side effects, lineage, and compensation fields correctly.

---

## Running tests

```bash
npm test
```

Tests run with Vitest in Node environment. They cover: Zod schema validation, adapter happy/error paths, receipt issuance + tamper detection, and the full `handleCap` dispatch pipeline.

---

## Deploy

```bash
# Set production secrets first
npx wrangler secret put RECEIPT_PRIVATE_KEY_JWK
npx wrangler secret put RECEIPT_PUBLIC_KEY_JWK
npx wrangler secret put VENDOR_DID

# Deploy
npx wrangler deploy
```

The Worker name, Durable Object bindings, and migration tags are in `wrangler.toml`.

---

## Routes

| Method | Path | Description |
|--------|------|-------------|
| POST | /v1/cap | Stoa/1 capability call |
| GET | /.well-known/stoa.json | Discovery document |
| GET | /.well-known/stoa-edge/keys.json | Receipt verification public key set |
| GET | /v1/saga/:plan_id/state | Saga state (debug) |
| POST | /v1/saga/:plan_id/compensate | Trigger compensation plan |
| GET | /v1/budget/:agent_id/status | Budget status |

---

## License

Apache-2.0. See [LICENSE](LICENSE).

Spec text (stoa-spec) is CC-BY-4.0. This runtime implementation is Apache-2.0.
