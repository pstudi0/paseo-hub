/** The YAML filter keys the form knows how to qualify. */
export type QualifierKey = "label" | "team";

/** Draft values for the qualifiers declared by the selected event. */
export type QualifierValues = Partial<Record<QualifierKey, string>>;

export interface QualifierDefinition {
  key: QualifierKey;
  kind: "string";
  label: string;
  description: string;
  required: boolean;
}

interface EventDefinition {
  provider: "github" | "slack" | "discord" | "linear" | "manual" | "schedule";
  label: string;
  origin: "hub" | "provider";
  qualifiers: readonly QualifierDefinition[];
}

const ADDED_LABEL: QualifierDefinition = {
  key: "label",
  kind: "string",
  label: "Added label",
  description:
    "Match the label added by this event, not labels already on the issue or pull request.",
  required: true,
};

/**
 * How a Linear agent session was started; the vocabulary of the `source` filter. `automation`
 * covers every session without a responsible human: triage rules, automations, and agent users.
 */
export const LINEAR_SESSION_SOURCES = ["delegation", "mention", "automation"] as const;
export type LinearSessionSource = (typeof LINEAR_SESSION_SOURCES)[number];

const LINEAR_TEAM: QualifierDefinition = {
  key: "team",
  kind: "string",
  label: "Linear team",
  description: "The Linear team UUID whose agent sessions this trigger serves.",
  required: true,
};

function event(
  provider: EventDefinition["provider"],
  label: string,
  qualifiers: readonly QualifierDefinition[] = [],
): EventDefinition {
  return {
    provider,
    label,
    qualifiers,
    origin: provider === "manual" || provider === "schedule" ? "hub" : "provider",
  };
}

const EVENTS = {
  "slack.mention": event("slack", "Slack mention"),
  "discord.mention": event("discord", "Discord mention"),
  "github.issue_created": event("github", "GitHub issue created"),
  "github.pull_request_created": event("github", "GitHub pull request created"),
  "github.issue_comment_created": event("github", "GitHub issue comment created"),
  "github.pull_request_comment_created": event("github", "GitHub pull request comment created"),
  "github.issue_label_added": event("github", "GitHub issue label added", [ADDED_LABEL]),
  "github.pull_request_label_added": event("github", "GitHub pull request label added", [
    ADDED_LABEL,
  ]),
  "github.issue_comment": event("github", "GitHub issue or PR comment webhook"),
  "github.issues": event("github", "GitHub issue webhook"),
  "github.pull_request": event("github", "GitHub pull request webhook"),
  "github.pull_request_review": event("github", "GitHub pull request review webhook"),
  "github.pull_request_review_comment": event("github", "GitHub review comment webhook"),
  "github.push": event("github", "GitHub push"),
  "linear.issue_entered_scope": event("linear", "Linear issue entered scope"),
  "linear.issue_assigned": event("linear", "Linear issue assigned"),
  "linear.comment_created": event("linear", "Linear comment created"),
  "linear.agent_session_created": event("linear", "Linear agent session created", [LINEAR_TEAM]),
  "linear.agent_session_prompted": event("linear", "Linear agent session prompted", [LINEAR_TEAM]),
  "schedule.tick": event("schedule", "Schedule"),
  "manual.run": event("manual", "Manual run"),
};

export type EditorEvent = keyof typeof EVENTS;
export const EDITOR_EVENTS = Object.keys(EVENTS).filter(isEditorEvent);

export function isEditorEvent(value: string): value is EditorEvent {
  return Object.hasOwn(EVENTS, value);
}

export function parseEditorEvent(value: string): EditorEvent {
  return isEditorEvent(value) ? value : "manual.run";
}

export function eventDefinition(eventId: EditorEvent): EventDefinition {
  return EVENTS[eventId];
}

/** The two Linear agent-session events: the only events that carry a session and a team. */
export const LINEAR_AGENT_SESSION_EVENTS = [
  "linear.agent_session_created",
  "linear.agent_session_prompted",
] as const satisfies readonly EditorEvent[];

export type LinearAgentSessionEvent = (typeof LINEAR_AGENT_SESSION_EVENTS)[number];

export function isLinearAgentSessionEvent(value: string): value is LinearAgentSessionEvent {
  return (LINEAR_AGENT_SESSION_EVENTS as readonly string[]).includes(value);
}
