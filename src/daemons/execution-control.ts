import type { AgentPermissionResponse } from "./agents/index.js";

export type SteerOutcome =
  | "sent"
  | "agent_pending"
  | "not_live"
  | { status: "permission_pending"; requestId: string };

export type PermissionAnswerOutcome =
  | "resolved"
  | "unconfirmed"
  | "not_live"
  | "permission_missing"
  | { status: "rejected"; error: string };

/**
 * Live control over an execution's daemon agent, for provider follow-ups that must not create a
 * new execution: steering the running turn, interrupting it, or answering a pending permission.
 * Every operation resolves the daemon connection and the session at call time.
 */
export interface ExecutionControl {
  steer(executionId: string, messageId: string, text: string): Promise<SteerOutcome>;
  /** Cancels the agent and fails the execution without any Hub action; false when not live. */
  interrupt(executionId: string, reason: string): Promise<boolean>;
  respondToPermission(
    executionId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<PermissionAnswerOutcome>;
  readWorkspacePullRequest(
    executionId: string,
  ): Promise<{ url: string; title?: string } | undefined>;
  daemonPermissions(daemonId: string): Promise<readonly string[]>;
}

export class ExecutionControlUnboundError extends Error {
  constructor() {
    super("Execution control is not bound to a daemon lifecycle yet");
    this.name = "ExecutionControlUnboundError";
  }
}

export type DeferredExecutionControl = ExecutionControl & { bind(control: ExecutionControl): void };

/**
 * Providers are constructed before the daemon lifecycle that controls their executions; the
 * deferred control is handed to them first and bound once the lifecycle exists. A call before
 * `bind` rejects loudly rather than pretending nothing is live.
 */
export function createDeferredExecutionControl(): DeferredExecutionControl {
  let bound: ExecutionControl | undefined;
  const control = (): ExecutionControl => {
    if (bound === undefined) throw new ExecutionControlUnboundError();
    return bound;
  };
  return {
    bind(target) {
      bound = target;
    },
    steer: async (executionId, messageId, text) => control().steer(executionId, messageId, text),
    interrupt: async (executionId, reason) => control().interrupt(executionId, reason),
    respondToPermission: async (executionId, requestId, response) =>
      control().respondToPermission(executionId, requestId, response),
    readWorkspacePullRequest: async (executionId) =>
      control().readWorkspacePullRequest(executionId),
    daemonPermissions: async (daemonId) => control().daemonPermissions(daemonId),
  };
}
