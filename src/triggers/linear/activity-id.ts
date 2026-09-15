import { createHash } from "node:crypto";

/**
 * A client-minted `AgentActivityCreateInput.id` derived from a deterministic seed, so an emission
 * retried after a restart carries the same identity. Formatted as a UUID v4 (version nibble `4`,
 * RFC variant `8`) because Linear validates the shape, not the randomness.
 */
export function deriveLinearActivityId(seed: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(["linear-activity", seed]))
    .digest("hex");
  const hex = digest.slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "8";
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}
