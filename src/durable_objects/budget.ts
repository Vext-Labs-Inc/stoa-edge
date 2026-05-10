/**
 * budget.ts — Budget Durable Object.
 *
 * One BudgetDO per agent_id. Enforces the per-call and per-run cost ceiling
 * declared in the Stoa/1 request envelope (budget.ceiling_cents).
 *
 * Storage schema:
 *   spent_cents    → number (cumulative spend across all calls in this DO lifetime)
 *   ceiling_cents  → number (set on first charge; subsequent charges use the same ceiling
 *                            unless explicitly reset)
 *   currency       → string (default "USD")
 *   charges        → JSON<ChargeRecord[]>
 *
 * Note: For v0 the ceiling is per-DO-lifetime (reset on DO eviction). A production
 * implementation should scope ceiling to a plan_id or session_id stored in the key.
 */

export interface ChargeRecord {
  idem: string;
  cap: string;
  amount_cents: number;
  charged_at: number; // Unix ms
}

export interface BudgetStatus {
  spent_cents: number;
  ceiling_cents: number;
  currency: string;
  available_cents: number;
  charges: ChargeRecord[];
}

export interface ChargeResult {
  ok: true;
  spent_cents: number;
  available_cents: number;
}

export interface ChargeExceeded {
  ok: false;
  code: "cost_limit_exceeded";
  message: string;
  spent_cents: number;
  ceiling_cents: number;
}

export type ChargeOutcome = ChargeResult | ChargeExceeded;

export class BudgetDO implements DurableObject {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // POST /charge — attempt to charge an amount
    if (request.method === "POST" && url.pathname === "/charge") {
      const body = (await request.json()) as {
        idem: string;
        cap: string;
        amount_cents: number;
        ceiling_cents: number;
        currency?: string;
      };
      const result = await this.charge(
        body.idem,
        body.cap,
        body.amount_cents,
        body.ceiling_cents,
        body.currency ?? "USD",
      );
      const status = result.ok ? 200 : 402;
      return Response.json(result, { status });
    }

    // GET /status — current budget status
    if (request.method === "GET" && url.pathname === "/status") {
      return Response.json(await this.available());
    }

    return new Response("Not found", { status: 404 });
  }

  /**
   * Attempt to charge `amount_cents` against the agent's budget.
   * Returns 402 shape if the ceiling would be exceeded.
   *
   * Idempotent: duplicate idem keys return the original charge result.
   */
  async charge(
    idem: string,
    cap: string,
    amount_cents: number,
    ceiling_cents: number,
    currency: string,
  ): Promise<ChargeOutcome> {
    // Check for duplicate charge
    const charges =
      (await this.state.storage.get<ChargeRecord[]>("charges")) ?? [];
    const existing = charges.find((c) => c.idem === idem);
    if (existing) {
      const spent = await this.state.storage.get<number>("spent_cents") ?? 0;
      return {
        ok: true,
        spent_cents: spent,
        available_cents: ceiling_cents - spent,
      };
    }

    const spent = (await this.state.storage.get<number>("spent_cents")) ?? 0;
    const proposedSpend = spent + amount_cents;

    if (proposedSpend > ceiling_cents) {
      return {
        ok: false,
        code: "cost_limit_exceeded",
        message: `Charge of ${amount_cents}¢ would exceed ceiling of ${ceiling_cents}¢ (already spent ${spent}¢)`,
        spent_cents: spent,
        ceiling_cents,
      };
    }

    // Commit the charge
    const newSpent = proposedSpend;
    await this.state.storage.put("spent_cents", newSpent);
    await this.state.storage.put("ceiling_cents", ceiling_cents);
    await this.state.storage.put("currency", currency);

    const record: ChargeRecord = {
      idem,
      cap,
      amount_cents,
      charged_at: Date.now(),
    };
    charges.push(record);
    await this.state.storage.put("charges", charges);

    return {
      ok: true,
      spent_cents: newSpent,
      available_cents: ceiling_cents - newSpent,
    };
  }

  /**
   * Return the current budget status.
   */
  async available(): Promise<BudgetStatus> {
    const spent = (await this.state.storage.get<number>("spent_cents")) ?? 0;
    const ceiling = (await this.state.storage.get<number>("ceiling_cents")) ?? 0;
    const currency =
      (await this.state.storage.get<string>("currency")) ?? "USD";
    const charges =
      (await this.state.storage.get<ChargeRecord[]>("charges")) ?? [];
    return {
      spent_cents: spent,
      ceiling_cents: ceiling,
      currency,
      available_cents: Math.max(0, ceiling - spent),
      charges,
    };
  }
}
