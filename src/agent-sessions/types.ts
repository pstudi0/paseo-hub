import type { DaemonCreateAgentOptions } from "../daemons/protocol.js";
import type { OutputToolDefinition } from "../execution-capabilities/outputs.js";

export type AgentSessionAction = "created" | "continued" | "restored";

/** How the daemon workspace of a workspace-keyed session was obtained for its first agent. */
export type AgentSessionWorkspaceAction = "created" | "reused" | "restored" | "recreated";

export interface AgentSessionWorkspaceResolution {
  /** ISO timestamp; the resolution is persisted before the daemon creates the agent. */
  resolvedAt: string;
  action: AgentSessionWorkspaceAction;
  /** The daemon's reason when an earlier workspace of the key could not be restored. */
  unrecoverableReason?: string;
}

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
  /**
   * Set once the workspace for a workspace-keyed session has been chosen and folded into
   * `creationOptions`, so a replayed dispatch sends the daemon the identical creation request.
   * Rows written before the field existed read back as `null`.
   */
  workspaceResolution: AgentSessionWorkspaceResolution | null;
  daemonId: string;
  agentId: string | null;
  workspaceId: string | null;
  compatibility: string;
  creationOptions: DaemonCreateAgentOptions;
  capabilityTokenHash: string;
  tools: readonly OutputToolDefinition[];
}
