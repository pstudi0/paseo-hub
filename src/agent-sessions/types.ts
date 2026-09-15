import type { DaemonCreateAgentOptions } from "../daemons/protocol.js";
import type { OutputToolDefinition } from "../execution-capabilities/outputs.js";

export type AgentSessionAction = "created" | "continued" | "restored";

export interface AgentSessionRecord {
  id: string;
  organizationId: string;
  projectId: string;
  continuationKey: string | null;
  /**
   * Groups sessions that share one daemon workspace (for example one Linear issue), independently
   * of the per-session continuation key. Persisted rows written before the column existed read
   * back as `null`.
   */
  workspaceKey: string | null;
  daemonId: string;
  agentId: string | null;
  workspaceId: string | null;
  compatibility: string;
  creationOptions: DaemonCreateAgentOptions;
  capabilityTokenHash: string;
  tools: readonly OutputToolDefinition[];
}
