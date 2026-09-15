import type {
  CompiledTriggerConfig as CompiledTrigger,
  TriggerFilter,
} from "../../config/index.js";
import {
  humanRootComment,
  linearSessionSource,
  type NormalizedLinearAgentSessionEvent,
  type NormalizedLinearCommentEvent,
  type NormalizedLinearEvent,
  type NormalizedLinearIssue,
  type NormalizedLinearIssueEvent,
} from "./events.js";

type MatchedTriggerDefinition = Pick<CompiledTrigger, "name" | "on" | "filters">;

export interface MatchedLinearTrigger {
  event: NormalizedLinearEvent;
  trigger: MatchedTriggerDefinition;
}

/**
 * Preserve the human message as the prompt while handing its input parser the text after its
 * command marker. A command `pattern` is consumed only at a boundary; a `contains` marker is
 * then found in the remaining tail. Input-shaped markers such as `repo=hub` remain in the parser
 * text. A session prompt parses like a comment; a created session parses its mention comment
 * when a human wrote one and nothing otherwise: neither `promptContext` nor Linear's artificial
 * root comment is human input.
 */
export function readLinearInvocationParserMessage(
  event: NormalizedLinearCommentEvent | NormalizedLinearAgentSessionEvent,
  filter: TriggerFilter | undefined,
): string {
  const body = invocationBody(event);
  const pattern = readCommentTextFilter(filter, "pattern");
  const contains = readCommentTextFilter(filter, "contains");

  const consumedPatternEnd = consumeLeadingLinearCommandMarker(body, pattern);
  if (pattern !== undefined && !pattern.includes("=") && consumedPatternEnd === undefined) {
    return body;
  }
  if (consumedPatternEnd !== undefined) {
    const overlappingContainsEnd = findOverlappingContainsEnd(body, contains, consumedPatternEnd);
    if (overlappingContainsEnd !== undefined) {
      return contains!.includes("=")
        ? body.slice(skipLeadingWhitespace(body, consumedPatternEnd))
        : body.slice(overlappingContainsEnd).trimStart();
    }

    const parserStart = skipLeadingWhitespace(body, consumedPatternEnd);
    const containsIndex = findBoundaryDelimitedMarker(body, contains, parserStart);
    return containsIndex === undefined
      ? body.slice(parserStart)
      : parserMessageAfterContains(body, containsIndex, contains!);
  }

  const containsIndex = findBoundaryDelimitedMarker(body, contains);
  if (containsIndex === undefined) return body;

  const parserMessage = parserMessageAfterContains(body, containsIndex, contains!);
  return isLeadingInputShapedPattern(body, pattern) && containsIndex > 0
    ? `${pattern} ${parserMessage}`
    : parserMessage;
}

/**
 * Match Linear's entity-level webhooks onto the small set of workflow-facing events. A scope
 * transition is edge-triggered: an eligible issue creates one run when it enters scope rather
 * than another run for every later title, estimate, or description update.
 */
export function matchLinearTriggers(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedLinearEvent,
  connectionId?: string | null,
): MatchedLinearTrigger[] {
  return config.triggers.flatMap((trigger) => {
    if (!matchesLinearEvent(trigger.on, event)) return [];
    if (!matchesTriggerFilter(trigger, event, connectionId)) return [];
    return [{ event, trigger }];
  });
}

export function matchesIssueScope(
  issue: NormalizedLinearIssue,
  filter: TriggerFilter | undefined,
  connectionId?: string | null,
): boolean {
  if (filter === undefined) return false;
  if (filter.connectionId !== undefined && filter.connectionId !== connectionId) return false;
  if (filter.project !== undefined && filter.project !== issue.projectId) return false;
  if (filter.states !== undefined && !matchesOptionalId(filter.states, issue.stateId)) return false;
  if (filter.assignees !== undefined && !matchesOptionalId(filter.assignees, issue.assigneeId)) {
    return false;
  }
  if (
    filter.labels !== undefined &&
    !filter.labels.every((label) => issue.labelIds.includes(label))
  ) {
    return false;
  }
  if (
    filter.exclude_labels !== undefined &&
    filter.exclude_labels.some((label) => issue.labelIds.includes(label))
  ) {
    return false;
  }
  return true;
}

function invocationBody(
  event: NormalizedLinearCommentEvent | NormalizedLinearAgentSessionEvent,
): string {
  if (event.type === "comment") return event.comment.body;
  if (event.activity !== null) return event.activity.body;
  return humanRootComment(event)?.body ?? "";
}

function matchesLinearEvent(eventName: string, event: NormalizedLinearEvent): boolean {
  if (eventName === "linear.agent_session_created") {
    return event.type === "agent_session" && event.action === "created";
  }
  if (eventName === "linear.agent_session_prompted") {
    return event.type === "agent_session" && event.action === "prompted";
  }
  if (eventName === "linear.issue_entered_scope") {
    return event.type === "issue" && (event.action === "create" || event.action === "update");
  }
  if (eventName === "linear.issue_assigned") {
    return (
      event.type === "issue" &&
      event.action === "update" &&
      event.issue.assigneeId !== null &&
      Object.hasOwn(event.updatedFrom, "assigneeId")
    );
  }
  return (
    eventName === "linear.comment_created" && event.type === "comment" && event.action === "create"
  );
}

function matchesTriggerFilter(
  trigger: MatchedTriggerDefinition,
  event: NormalizedLinearEvent,
  connectionId?: string | null,
): boolean {
  if (event.type === "agent_session") {
    return matchesSessionScope(event, trigger.filters, connectionId);
  }
  if (trigger.on === "linear.issue_entered_scope") {
    return (
      event.type === "issue" &&
      enteredConfiguredScope(event, trigger.filters, connectionId) &&
      matchesActorIfPresent(event, trigger.filters?.from_users)
    );
  }
  const issue = event.type === "issue" ? event.issue : event.issue;
  if (issue === null || !matchesIssueScope(issue, trigger.filters, connectionId)) return false;
  if (!matchesActor(event, trigger.filters?.from_users)) return false;
  if (event.type === "comment" && !matchesCommentText(event, trigger.filters)) return false;
  return true;
}

/**
 * A session is served by the trigger of its issue's team. The actor is whoever addressed the
 * agent: the creator of a new session, the author of a follow-up prompt. A session without a
 * responsible human is only accepted when the trigger opts into automations, and then
 * `from_users` has nobody to check.
 */
export function matchesSessionScope(
  event: NormalizedLinearAgentSessionEvent,
  filter: TriggerFilter | undefined,
  connectionId?: string | null,
): boolean {
  if (filter === undefined) return false;
  if (filter.connectionId !== undefined && filter.connectionId !== connectionId) return false;
  if (event.session.issue === null) return false;
  if (filter.team !== event.session.issue.teamId) return false;
  if (filter.source !== undefined && !filter.source.includes(linearSessionSource(event))) {
    return false;
  }
  const actor = event.action === "created" ? event.session.creator : event.activity?.user;
  if (actor === null || actor === undefined) return filter.allow_automations === true;
  return matchesSessionActor(actor, filter.from_users, event.action === "prompted");
}

/**
 * The only place `"*"` is honored, and only for follow-ups: a delegation runs code on the
 * daemon, so the compiler refuses the wildcard on `created` and matching never honors it there.
 */
function matchesSessionActor(
  actor: { id: string },
  allowed: readonly string[] | undefined,
  wildcard: boolean,
): boolean {
  if (allowed === undefined || allowed.length === 0) return false;
  return (wildcard && allowed.includes("*")) || allowed.includes(actor.id);
}

/** The filter-specific edge check, separated to keep the generic event selection readable. */
function enteredConfiguredScope(
  event: NormalizedLinearIssueEvent,
  filter: TriggerFilter | undefined,
  connectionId?: string | null,
): boolean {
  if (!matchesIssueScope(event.issue, filter, connectionId)) return false;
  if (event.action === "create") return true;
  if (event.action !== "update") return false;
  const before: NormalizedLinearIssue = {
    ...event.issue,
    ...(Object.hasOwn(event.updatedFrom, "projectId")
      ? { projectId: event.updatedFrom.projectId ?? null }
      : {}),
    ...(Object.hasOwn(event.updatedFrom, "stateId")
      ? { stateId: event.updatedFrom.stateId ?? null }
      : {}),
    ...(Object.hasOwn(event.updatedFrom, "assigneeId")
      ? { assigneeId: event.updatedFrom.assigneeId ?? null }
      : {}),
    ...(Object.hasOwn(event.updatedFrom, "labelIds")
      ? { labelIds: event.updatedFrom.labelIds ?? [] }
      : {}),
  };
  return !matchesIssueScope(before, filter, connectionId);
}

function matchesActorIfPresent(
  event: NormalizedLinearIssueEvent,
  allowed: readonly string[] | undefined,
): boolean {
  return allowed === undefined || allowed.length === 0 || matchesActor(event, allowed);
}

function matchesActor(
  event: NormalizedLinearIssueEvent | NormalizedLinearCommentEvent,
  allowed: readonly string[] | undefined,
): boolean {
  if (allowed === undefined || allowed.length === 0 || event.actor === null) return false;
  return allowed.includes(event.actor.id);
}

function matchesOptionalId(allowed: readonly string[], value: string | null): boolean {
  return value !== null && allowed.includes(value);
}

function matchesCommentText(
  event: NormalizedLinearCommentEvent,
  filter: TriggerFilter | undefined,
): boolean {
  const pattern = filter?.pattern;
  if (pattern !== undefined && !event.comment.body.startsWith(pattern)) return false;
  const contains = filter?.contains;
  return contains === undefined || event.comment.body.includes(contains);
}

function consumeLeadingLinearCommandMarker(
  message: string,
  marker: string | undefined,
): number | undefined {
  if (marker === undefined || marker.includes("=") || !message.startsWith(marker)) {
    return undefined;
  }
  return hasTrailingMarkerBoundary(message, marker.length) ? marker.length : undefined;
}

function findOverlappingContainsEnd(
  message: string,
  marker: string | undefined,
  consumedPatternEnd: number,
): number | undefined {
  const markerIndex = findBoundaryDelimitedMarker(message, marker);
  if (markerIndex === undefined || markerIndex >= consumedPatternEnd) return undefined;
  return Math.max(consumedPatternEnd, markerIndex + marker!.length);
}

function parserMessageAfterContains(message: string, markerIndex: number, marker: string): string {
  return marker.includes("=")
    ? message.slice(markerIndex)
    : message.slice(markerIndex + marker.length).trimStart();
}

function isLeadingInputShapedPattern(
  message: string,
  marker: string | undefined,
): marker is string {
  return (
    marker !== undefined &&
    marker.includes("=") &&
    message.startsWith(marker) &&
    hasTrailingMarkerBoundary(message, marker.length)
  );
}

function findBoundaryDelimitedMarker(
  message: string,
  marker: string | undefined,
  from = 0,
): number | undefined {
  if (marker === undefined) return undefined;
  let start = from;
  while (start < message.length) {
    const index = message.indexOf(marker, start);
    if (index === -1) return undefined;
    const before = message.at(index - 1);
    if (
      (index === 0 || (before !== undefined && /\s/u.test(before))) &&
      hasTrailingMarkerBoundary(message, index + marker.length)
    ) {
      return index;
    }
    start = index + marker.length;
  }
  return undefined;
}

function hasTrailingMarkerBoundary(message: string, end: number): boolean {
  const after = message.at(end);
  return after === undefined || /\s/u.test(after);
}

function skipLeadingWhitespace(message: string, from: number): number {
  let start = from;
  while (start < message.length && /\s/u.test(message[start]!)) start += 1;
  return start;
}

function readCommentTextFilter(
  filter: TriggerFilter | undefined,
  key: "pattern" | "contains",
): string | undefined {
  const value = filter?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
