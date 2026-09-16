/**
 * Every sentence the Hub writes into a Linear agent session. Linear renders these verbatim in the
 * session timeline, so they address the person who delegated the issue, never the operator.
 */
export const LINEAR_COPY = {
  ack: "Thinking…",
  queued: "Queued…",
  started: "Working…",
  followUpReceived: "Thinking…",
  followUpDelivered: "Follow-up delivered to the running agent.",
  followUpQueued: "Follow-up queued; it will be delivered as soon as the agent is ready.",
  followUpUndeliverable:
    "The follow-up could not be delivered to the running agent; it will be delivered on the next run.",
  stillWorking: "Still working…",
  turnFailed: (error: string): string => `The agent's turn failed: ${error}`,
  dropNoProject:
    "No Paseo project is configured for this team. Add a linear.agent_session_created trigger with this team's ID, or check the trigger's from_users allowlist.",
  dropConfiguration:
    "The Linear connection in Paseo Hub must be re-authorized before agent sessions can run.",
  dispatchFailed:
    "Paseo Hub could not start a run for this session. Delegate the issue again or reply here to retry.",
  stopped: (name?: string): string =>
    `Stopped${name === undefined ? "" : ` at ${name}'s request`}. The workspace and branch are kept; delegating again or replying here resumes in the same workspace.`,
  unassigned: "Stopped because the issue was unassigned from the agent. The workspace is kept.",
  nothingRunning: "Nothing is running for this session.",
  permissionWaitingWithoutAuthority: (title: string): string =>
    `The agent is waiting for a permission decision in Paseo (${title}). Approve it there, grant the daemon workspace.write to answer from Linear, or run this trigger in a mode without approvals.`,
  questionInPaseo: (title: string): string =>
    `The agent asked a question that must be answered in Paseo (${title}).`,
  permissionResolved: "Permission resolved in Paseo.",
  permissionRefused: (error: string): string => `Paseo refused the permission answer: ${error}`,
  permissionUnconfirmed:
    "The permission answer was sent to Paseo but not confirmed; check the agent in Paseo.",
  workspaceUnrecoverable: (reason: string): string =>
    `The issue's workspace could not be restored (${reason}); starting from a fresh branch.`,
  fallbackResponse: "The agent finished this turn without a written summary.",
  runCompleted: "Run completed.",
} as const;

const RETRY_HINT =
  " Delegating the issue again or replying here starts a new run in the same workspace.";

const DAEMON_REASONS = new Set([
  "daemon_unreachable",
  "daemon_not_registered",
  "daemon_disconnected",
  "daemon_disconnected_mid_execution",
  "daemon_timeout",
]);
const RUNTIME_REASONS = new Set([
  "timeout",
  "step_hard_timeout",
  "whole_run_timeout",
  "workflow_timed_out",
]);
const IDLE_REASONS = new Set(["idle_timeout", "step_idle_timeout"]);
const CREDENTIAL_REASONS = new Set([
  "execution_credentials_unavailable",
  "github_authority_unavailable",
  "github_authority_scope_invalid",
  "github_integration_unavailable",
]);

/** The `error` activity body for a failed execution; every text ends with the retry hint. */
export function linearErrorFor(reason: string): string {
  if (DAEMON_REASONS.has(reason)) {
    return `The Paseo daemon for this project is not reachable.${RETRY_HINT}`;
  }
  if (RUNTIME_REASONS.has(reason)) return `The run exceeded its maximum runtime.${RETRY_HINT}`;
  if (IDLE_REASONS.has(reason)) {
    return `The run ended after the agent stayed idle for longer than the configured idle_timeout.${RETRY_HINT}`;
  }
  if (reason === "agent_interrupted") return `The agent process stopped unexpectedly.${RETRY_HINT}`;
  if (CREDENTIAL_REASONS.has(reason)) {
    return `The run's credentials could not be prepared.${RETRY_HINT}`;
  }
  return `The run failed: ${reason}.${RETRY_HINT}`;
}

export function isLinearIdleReason(reason: string): boolean {
  return IDLE_REASONS.has(reason);
}
