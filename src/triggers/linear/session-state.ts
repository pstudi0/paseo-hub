import type { LinearApiClient, LinearTeamState } from "../../providers/linear/client.js";
import type { LinearActivityQueue } from "./activity-queue.js";

/**
 * State that outlives one provider registration. Registrations are rebuilt on every configuration
 * activation; activity queues, keepalives and caches must survive that, so they live here and the
 * registration only rebinds `client`.
 */
export interface LinearSessionState {
  /** One outbound queue per Linear agent session id. */
  readonly queues: Map<string, LinearActivityQueue>;
  /** Team workflow states keyed by `${linearOrganizationId}:${teamId}`. */
  readonly teamStates: Map<string, { readAt: number; states: LinearTeamState[] }>;
  readonly keepalives: Map<string, ReturnType<typeof setTimeout>>;
  /** The plan shape Linear accepted per organization (documentation says array, SDL says object). */
  readonly planShapes: Map<string, "array" | "object">;
  /**
   * The placeholder comment a session owes an answer to, by Linear session id. A person who writes
   * in a comment thread gets their answer in that thread, as an ordinary reply that starts as
   * "Working…" and is rewritten with the result; the session keeps the detailed activity.
   */
  readonly threadReplies: Map<string, LinearThreadReply>;
  /**
   * Issues whose delegated work owes a closing comment, by Linear session id. A session card is
   * only opened by the people who look for it, so work someone delegated also ends with an
   * ordinary comment on the issue: that is what the rest of the team reads, and what tells them
   * the issue has been handled.
   */
  readonly conclusions: Map<string, string>;
  /** The API client of the active registration; resolved at send time, never at enqueue. */
  client: LinearApiClient | undefined;
}

/** A comment the agent has already posted in a human thread and will rewrite with its answer. */
export interface LinearThreadReply {
  commentId: string;
  issueId: string;
}

export function createLinearSessionState(): LinearSessionState {
  return {
    queues: new Map(),
    teamStates: new Map(),
    keepalives: new Map(),
    planShapes: new Map(),
    threadReplies: new Map(),
    conclusions: new Map(),
    client: undefined,
  };
}
