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
  /** The API client of the active registration; resolved at send time, never at enqueue. */
  client: LinearApiClient | undefined;
}

export function createLinearSessionState(): LinearSessionState {
  return {
    queues: new Map(),
    teamStates: new Map(),
    keepalives: new Map(),
    planShapes: new Map(),
    client: undefined,
  };
}
