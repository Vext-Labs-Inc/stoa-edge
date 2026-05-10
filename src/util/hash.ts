/**
 * hash.ts — SHA-256 helpers for the Stoa Edge runtime.
 * Uses the Web Crypto API (available in both CF Workers and modern browsers).
 */

/**
 * Returns "sha256:<lowercase hex>" for any serializable value.
 * The value is JSON-serialized (deterministic via sorted keys) before hashing.
 */
export async function sha256Hex(value: unknown): Promise<string> {
  const json = stableStringify(value);
  const bytes = new TextEncoder().encode(json);
  const buffer = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

/**
 * Returns "sha256:<lowercase hex>" for a raw string (not re-serialized).
 */
export async function sha256String(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const buffer = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

/**
 * Stable (sorted-key) JSON serialization so hash(obj) is deterministic
 * regardless of insertion order.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}
