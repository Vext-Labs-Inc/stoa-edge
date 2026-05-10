/**
 * saga.ts — Saga Durable Object.
 *
 * One SagaDO per plan_id. Persists (idem_key → receipt) checkpoints so that:
 *   1. Retries on a different worker still return the prior receipt (exactly-once).
 *   2. Partial-failure compensation can walk the recorded steps in reverse.
 *
 * Storage schema (all keys in DO KV):
 *   checkpoint:<idem>  → JSON<CheckpointEntry>
 *   steps              → JSON<string[]>  (ordered list of idem keys)
 *   status             → "active" | "compensating" | "completed" | "failed"
 */

import { Receipt } from "../wire";

export interface CheckpointEntry {
  idem: string;
  cap: string;
  receipt: Receipt;
  compensation?: {
    on_undo: string; // compensating cap URN
    key_path: string; // JSONPath into output to extract undo key
    undo_key_value?: string; // resolved at call time if available
  };
  recorded_at: number; // Unix ms
}

export interface SagaState {
  status: "active" | "compensating" | "completed" | "failed";
  steps: string[]; // ordered list of idem keys
}

export class SagaDO implements DurableObject {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    // POST /checkpoint — record a new step
    if (method === "POST" && url.pathname === "/checkpoint") {
      const entry = (await request.json()) as CheckpointEntry;
      return Response.json(await this.recordStep(entry));
    }

    // GET /checkpoint/:idem — look up an existing step
    if (method === "GET" && url.pathname.startsWith("/checkpoint/")) {
      const idem = decodeURIComponent(url.pathname.slice("/checkpoint/".length));
      const entry = await this.getCheckpoint(idem);
      if (!entry) return new Response("Not found", { status: 404 });
      return Response.json(entry);
    }

    // GET /state — full saga state
    if (method === "GET" && url.pathname === "/state") {
      return Response.json(await this.getState());
    }

    // POST /compensate — walk steps in reverse, return compensation plan
    if (method === "POST" && url.pathname === "/compensate") {
      return Response.json(await this.compensate());
    }

    return new Response("Not found", { status: 404 });
  }

  /**
   * Record a saga step. Idempotent: if the idem key already exists, returns
   * the existing entry without overwriting.
   */
  async recordStep(entry: CheckpointEntry): Promise<CheckpointEntry> {
    const storageKey = `checkpoint:${entry.idem}`;
    const existing =
      await this.state.storage.get<CheckpointEntry>(storageKey);
    if (existing) {
      return existing;
    }

    await this.state.storage.put(storageKey, entry);

    // Append to ordered steps list
    const steps = (await this.state.storage.get<string[]>("steps")) ?? [];
    steps.push(entry.idem);
    await this.state.storage.put("steps", steps);

    // Ensure status is set
    const status = await this.state.storage.get<string>("status");
    if (!status) {
      await this.state.storage.put("status", "active");
    }

    return entry;
  }

  /**
   * Look up a checkpoint by idempotency key.
   */
  async getCheckpoint(idem: string): Promise<CheckpointEntry | null> {
    return (
      (await this.state.storage.get<CheckpointEntry>(`checkpoint:${idem}`)) ??
      null
    );
  }

  /**
   * Get full saga state: status + ordered step list.
   */
  async getState(): Promise<SagaState> {
    const status =
      ((await this.state.storage.get<string>("status")) as SagaState["status"]) ??
      "active";
    const steps = (await this.state.storage.get<string[]>("steps")) ?? [];
    return { status, steps };
  }

  /**
   * Build a compensation plan: walk recorded steps in reverse order and return
   * the list of compensating capability calls to execute.
   *
   * The orchestrating worker is responsible for actually calling the compensating caps.
   * This DO only provides the plan; it does not execute it (that would require outbound
   * fetch from inside a DO, which is possible but kept out of scope for v0).
   */
  async compensate(): Promise<{
    plan: Array<{ idem: string; on_undo: string; undo_key_value?: string }>;
  }> {
    await this.state.storage.put("status", "compensating");
    const steps = (await this.state.storage.get<string[]>("steps")) ?? [];
    const plan: Array<{ idem: string; on_undo: string; undo_key_value?: string }> = [];

    // Walk in reverse (last step first — standard saga compensation order)
    for (const idem of [...steps].reverse()) {
      const entry = await this.state.storage.get<CheckpointEntry>(
        `checkpoint:${idem}`,
      );
      if (entry?.compensation?.on_undo) {
        plan.push({
          idem,
          on_undo: entry.compensation.on_undo,
          undo_key_value: entry.compensation.undo_key_value,
        });
      }
    }

    return { plan };
  }
}
