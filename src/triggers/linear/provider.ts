import type { CompiledLinearAuthority } from "../../config/index.js";
import type { JsonValue } from "../../config/schema.js";
import type { ProjectConfigurationStore } from "../../configuration/store.js";
import {
  LINEAR_ISSUE_COMMENT_CONTEXT_LIMIT,
  type LinearAgentSessionActivity,
  type LinearApiClient,
  type LinearIssueComment,
  type LinearIssueDetails,
} from "../../providers/linear/client.js";
import { reportFailure } from "../../failures/index.js";
import type { LinearSessionSource } from "../configuration/events.js";
import type { Conversation } from "../continuation.js";
import {
  asTriggerContextValue,
  type TriggerProvider,
  type TriggerProviderMatch,
} from "../index.js";
import { matchesInputFilters, parseInvocation } from "../invocation.js";
import {
  linearSessionSource,
  NormalizedLinearEventSchema,
  type NormalizedLinearAgentSessionEvent,
  type NormalizedLinearCommentEvent,
  type NormalizedLinearEvent,
  type NormalizedLinearIssueEvent,
} from "./events.js";
import { matchLinearTriggers, readLinearInvocationParserMessage } from "./match.js";
import { createLinearSessionHooks, type LinearSessionHookDependencies } from "./session-hooks.js";

export interface LinearIssueOutputContext {
  provider: "linear";
  linearOrganizationId: string;
  issueId: string;
}

/** The target of agent-session outputs: the session receives activities, the issue links. */
export interface LinearSessionOutputContext extends LinearIssueOutputContext {
  teamId: string;
  sessionId: string;
}

export type LinearOutputContext = LinearIssueOutputContext | LinearSessionOutputContext;

interface LinearContextUser {
  id: string;
  name?: string | undefined;
}

interface LinearContextTeam {
  id: string;
  key: string;
  name: string;
}

interface LinearContextThreadComment {
  id: string;
  body: string;
  user_id: string | null;
}

export interface LinearIssueEventContext {
  event_type: "issue" | "comment";
  action: "create" | "update" | "remove";
  delivery_id: string;
  connection_id: string | null;
  organization: { id: string };
  actor: LinearContextUser | null;
  issue: {
    id: string;
    identifier?: string;
    title: string;
    description: string | null;
    url?: string;
    project: { id: string } | null;
    state: { id: string } | null;
    assignee: { id: string } | null;
    label_ids: string[];
  };
  comment: { id: string; body: string } | null;
  trigger_thread_context:
    | {
        status: "deferred";
        issue: { id: string };
        before: { created_at: string };
      }
    | { status: "unavailable" };
}

/**
 * An agent session as the workflow sees it. `delivery_id` is the receipt's identity (the session
 * for `created`, the prompt activity for `prompted`); `transport_delivery_id` is the header of
 * the delivery that was accepted. The causal bound of the deferred history is the trigger itself,
 * whose body is already the prompt, so the history never repeats it.
 */
export interface LinearSessionEventContext {
  event_type: "agent_session";
  action: "created" | "prompted";
  delivery_id: string;
  transport_delivery_id?: string;
  connection_id: string | null;
  organization: { id: string };
  app_user: { id: string };
  actor: LinearContextUser | null;
  source: LinearSessionSource;
  session: { id: string; status: string; url: string | null; created_at: string };
  issue: {
    id: string;
    identifier: string;
    title: string;
    description: string | null;
    url: string;
    project: null;
    state: null;
    assignee: null;
    label_ids: [];
  };
  team: LinearContextTeam;
  comment: LinearContextThreadComment | null;
  source_comment_id: string | null;
  creator: LinearContextUser | null;
  prompt_context: string | null;
  guidance: { body: string; origin: "organization" | "team"; team?: LinearContextTeam }[];
  previous_comments: LinearContextThreadComment[];
  activity: {
    id: string;
    body: string;
    created_at: string;
    signal: string | null;
    signal_metadata: JsonValue | null;
    source_comment_id: string | null;
    user: LinearContextUser;
  } | null;
  /** The compiled `run.linear` block of the trigger's first step; Hub holds no authority without it. */
  authority: CompiledLinearAuthority | null;
  trigger_thread_context:
    | {
        status: "deferred";
        session: { id: string };
        before: { created_at: string; activity_id: string | null };
      }
    | { status: "unavailable" };
}

export type LinearEventContext = LinearIssueEventContext | LinearSessionEventContext;

export interface LinearTriggerContext {
  provider: "linear";
  target: LinearOutputContext;
  event: { linear: LinearEventContext };
}

export interface LinearIssueContextMessage {
  id: string;
  content: string;
  author: { id: string; name?: string } | null;
  created_at: string | null;
  /** Absent for the issue root and comments of issue events; the activity type for sessions. */
  kind?: "comment" | "prompt" | "response" | "error" | "elicitation";
}

export interface LinearThreadContext {
  status: "available" | "incomplete" | "unavailable";
  messages: LinearIssueContextMessage[];
}

/** The session issue once `readIssue` has filled in what the session payload does not carry. */
export interface LinearMaterializedSessionIssue extends Omit<
  LinearSessionEventContext["issue"],
  "project" | "state" | "assignee" | "label_ids"
> {
  project: { id: string } | null;
  /** Name and type are known once `readIssue` answered; a bare id comes from a partial reader. */
  state: { id: string; name?: string; type?: string } | null;
  assignee: { id: string } | null;
  label_ids: string[];
  branch_name?: string;
  delegate?: { id: string } | null;
}

export type LinearMaterializedIssueEvent = Omit<
  LinearIssueEventContext,
  "trigger_thread_context"
> & {
  thread: LinearThreadContext;
};

export type LinearMaterializedSessionEvent = Omit<
  LinearSessionEventContext,
  "trigger_thread_context" | "issue"
> & { issue: LinearMaterializedSessionIssue; thread: LinearThreadContext };

export interface LinearMaterializedContext {
  linear: LinearMaterializedIssueEvent | LinearMaterializedSessionEvent;
}

/** Each capability is optional at runtime so a test double implements only what it exercises. */
export type LinearContextClient = Partial<
  Pick<LinearApiClient, "readIssueComments" | "readIssue" | "readAgentSessionActivities">
>;

export function createLinearTriggerProvider(options: {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  client?: LinearContextClient;
  /** Agent-session lifecycle hooks; absent when the registration has no session state. */
  session?: LinearSessionHookDependencies;
}): TriggerProvider<
  "linear",
  LinearTriggerContext,
  LinearOutputContext,
  LinearMaterializedContext
> {
  return {
    name: "linear",
    eventNames: ["linear.issue", "linear.comment", "linear.agent_session"],
    async match(externalTrigger) {
      const event = NormalizedLinearEventSchema.parse(externalTrigger.payload);
      const stored = await options
        .configurationStoreForProject(externalTrigger.projectId)
        .getRevision(externalTrigger.configurationRevisionId);
      if (stored === undefined) return "configuration_unavailable";
      if (!hasSourceTrigger(stored.configuration.triggers, externalTrigger.source)) {
        return "no_trigger_for_source";
      }
      const matched = matchLinearTriggers(
        stored.configuration,
        event,
        externalTrigger.connectionId,
      );
      if (matched.length === 0) return "trigger_filters_rejected";

      const matches: TriggerProviderMatch<LinearTriggerContext, LinearOutputContext>[] = [];
      for (const candidate of matched) {
        const compiledTrigger = stored.configuration.triggers.find(
          (trigger) => trigger.name === candidate.trigger.name,
        );
        if (compiledTrigger === undefined) {
          throw new Error(`compiled trigger not found: ${candidate.trigger.name}`);
        }
        const target = matchTarget(event, {
          deliveryId: externalTrigger.deliveryId,
          connectionId: externalTrigger.connectionId,
          authority: compiledTrigger.steps[0]?.linear ?? null,
        });
        if (target === undefined) continue;
        const prompt = promptForEvent(event);
        const invocation = parseInvocation(
          prompt,
          compiledTrigger.inputs,
          undefined,
          event.type === "issue"
            ? prompt
            : readLinearInvocationParserMessage(event, compiledTrigger.filters),
        );
        const match = {
          conversation: target.conversation,
          triggerName: candidate.trigger.name,
          triggerContext: target.triggerContext,
          outputContext: target.outputContext,
          configurationRevisionId: stored.revision.id,
          hubConfig: stored.configuration,
        };
        if (invocation.status === "accepted") {
          if (!matchesInputFilters(invocation.inputs, compiledTrigger.filters?.inputs)) continue;
          matches.push({ ...match, invocation });
        } else {
          matches.push({ ...match, invocation });
        }
      }
      return matches.length === 0 ? "trigger_filters_rejected" : matches;
    },
    async materializeContext(launch): Promise<LinearMaterializedContext> {
      const linear = launch.triggerContext.event.linear;
      return linear.event_type === "agent_session"
        ? materializeSessionContext(linear, options.client)
        : materializeIssueContext(linear, options.client);
    },
    ...(options.session === undefined ? {} : createLinearSessionHooks(options.session)),
  };
}

interface MatchTarget {
  conversation: Conversation;
  triggerContext: LinearTriggerContext;
  outputContext: LinearOutputContext;
}

function matchTarget(
  event: NormalizedLinearEvent,
  input: {
    deliveryId: string;
    connectionId: string | null | undefined;
    authority: CompiledLinearAuthority | null;
  },
): MatchTarget | undefined {
  if (event.type === "agent_session") {
    const issue = event.session.issue;
    if (issue === null) return undefined;
    const outputContext: LinearSessionOutputContext = {
      provider: "linear",
      linearOrganizationId: event.organizationId,
      issueId: issue.id,
      teamId: issue.teamId,
      sessionId: event.session.id,
    };
    return {
      conversation: {
        key: `linear:session:${event.session.id}`,
        label: "Linear session",
        ...(event.session.url === null ? {} : { url: event.session.url }),
        workspaceKey: `linear:issue:${issue.id}`,
      },
      triggerContext: {
        provider: "linear",
        target: outputContext,
        event: {
          linear: buildLinearSessionContext(
            event,
            input.deliveryId,
            input.connectionId,
            input.authority,
          ),
        },
      },
      outputContext,
    };
  }
  const issue = event.type === "issue" ? event.issue : event.issue;
  if (issue === null) return undefined;
  const outputContext: LinearIssueOutputContext = {
    provider: "linear",
    linearOrganizationId: event.organizationId,
    issueId: issue.id,
  };
  return {
    conversation: {
      key: JSON.stringify(["linear", event.organizationId, issue.id]),
      label: "Linear issue",
    },
    triggerContext: {
      provider: "linear",
      target: outputContext,
      event: {
        linear: buildLinearIssueContext(event, input.deliveryId, input.connectionId),
      },
    },
    outputContext,
  };
}

async function materializeIssueContext(
  context: LinearIssueEventContext,
  client: LinearContextClient | undefined,
): Promise<LinearMaterializedContext> {
  const { trigger_thread_context: locator, ...linear } = context;
  const root = issueRootMessage(linear.issue);
  if (locator.status !== "deferred" || client?.readIssueComments === undefined) {
    return { linear: { ...linear, thread: { status: "unavailable", messages: [root] } } };
  }
  try {
    const history = await client.readIssueComments({
      linearOrganizationId: linear.organization.id,
      issueId: locator.issue.id,
      beforeCreatedAt: locator.before.created_at,
    });
    const causalComments = history.comments.filter((comment) =>
      isBeforeLinearTrigger(comment, locator.before.created_at),
    );
    const messages = causalComments
      .sort(compareLinearOrder)
      .slice(-LINEAR_ISSUE_COMMENT_CONTEXT_LIMIT)
      .map(commentMessage);
    const complete =
      history.complete &&
      causalComments.length === history.comments.length &&
      causalComments.length <= LINEAR_ISSUE_COMMENT_CONTEXT_LIMIT;
    return {
      linear: {
        ...linear,
        thread: { status: complete ? "available" : "incomplete", messages: [root, ...messages] },
      },
    };
  } catch (error) {
    reportFailure(
      error,
      { operation: "linear.issue.history.hydrate", component: "triggers", provider: "linear" },
      { diagnostic: { linearOrganizationId: linear.organization.id, issueId: locator.issue.id } },
    );
    return { linear: { ...linear, thread: { status: "unavailable", messages: [root] } } };
  }
}

/**
 * A new session has no history of its own: its thread is known to be empty without any read, and
 * its prompt context already renders the issue and thread, so only the issue is hydrated. A
 * follow-up reads the session's conversation strictly before the prompt that triggered it, which
 * takes a client. Either way, a failure leaves the run usable.
 */
async function materializeSessionContext(
  context: LinearSessionEventContext,
  client: LinearContextClient | undefined,
): Promise<LinearMaterializedContext> {
  const { trigger_thread_context: locator, ...linear } = context;
  const unavailable = (): LinearMaterializedContext => ({
    linear: { ...linear, thread: { status: "unavailable", messages: [] } },
  });
  if (locator.status !== "deferred") return unavailable();
  try {
    if (linear.action === "created") {
      const issue = await hydrateSessionIssue(client, linear.organization.id, linear.issue);
      return { linear: { ...linear, issue, thread: { status: "available", messages: [] } } };
    }
    if (client === undefined) return unavailable();
    const thread = await sessionThreadContext(client, linear.organization.id, locator);
    if (thread === undefined) return unavailable();
    const issue = await hydrateSessionIssue(client, linear.organization.id, linear.issue);
    return { linear: { ...linear, issue, thread } };
  } catch (error) {
    reportFailure(
      error,
      {
        operation: "linear.agent_session.history.hydrate",
        component: "triggers",
        provider: "linear",
      },
      {
        diagnostic: {
          linearOrganizationId: linear.organization.id,
          issueId: linear.issue.id,
          sessionId: locator.session.id,
        },
      },
    );
    return unavailable();
  }
}

async function sessionThreadContext(
  client: LinearContextClient,
  linearOrganizationId: string,
  locator: Extract<LinearSessionEventContext["trigger_thread_context"], { status: "deferred" }>,
): Promise<LinearThreadContext | undefined> {
  if (client.readAgentSessionActivities === undefined) return undefined;
  const history = await client.readAgentSessionActivities({
    linearOrganizationId,
    agentSessionId: locator.session.id,
    beforeCreatedAt: locator.before.created_at,
    excludeActivityId: locator.before.activity_id,
  });
  // Thoughts and actions are the agent's own mirror, not the conversation; the trigger prompt is
  // already `paseo.prompt` verbatim.
  const conversation = history.activities
    .filter(hasActivityBody)
    .filter((activity) => activity.id !== locator.before.activity_id);
  const causal = conversation.filter((activity) =>
    isBeforeLinearTrigger(activity, locator.before.created_at),
  );
  const messages = causal
    .sort(compareLinearOrder)
    .slice(-LINEAR_ISSUE_COMMENT_CONTEXT_LIMIT)
    .map(activityMessage);
  const complete =
    history.complete &&
    causal.length === conversation.length &&
    causal.length <= LINEAR_ISSUE_COMMENT_CONTEXT_LIMIT;
  return { status: complete ? "available" : "incomplete", messages };
}

/** The issue as delivered when nothing can read it; never a fabricated state or assignee. */
async function hydrateSessionIssue(
  client: LinearContextClient | undefined,
  linearOrganizationId: string,
  issue: LinearSessionEventContext["issue"],
): Promise<LinearMaterializedSessionIssue> {
  if (client?.readIssue === undefined) return issue;
  const details = await client.readIssue({ linearOrganizationId, issueId: issue.id });
  if (details === undefined) return issue;
  return {
    ...issue,
    ...(details.branchName === undefined ? {} : { branch_name: details.branchName }),
    project: details.projectId === null ? null : { id: details.projectId },
    state: hydratedState(details),
    assignee: details.assigneeId === null ? null : { id: details.assigneeId },
    label_ids: [...details.labelIds],
    ...(details.delegateId === undefined
      ? {}
      : { delegate: details.delegateId === null ? null : { id: details.delegateId } }),
  };
}

function hydratedState(details: LinearIssueDetails): LinearMaterializedSessionIssue["state"] {
  if (details.state !== undefined) return details.state;
  return details.stateId === null ? null : { id: details.stateId };
}

function issueRootMessage(issue: LinearIssueEventContext["issue"]): LinearIssueContextMessage {
  return {
    id: issue.id,
    content:
      issue.description === null || issue.description.length === 0
        ? issue.title
        : `${issue.title}\n\n${issue.description}`,
    author: null,
    created_at: null,
  };
}

function commentMessage(comment: LinearIssueComment): LinearIssueContextMessage {
  return {
    id: comment.id,
    content: comment.body,
    author: comment.author,
    created_at: comment.createdAt,
  };
}

type ConversationActivity = LinearAgentSessionActivity & {
  content: Extract<LinearAgentSessionActivity["content"], { body: string }>;
};

function hasActivityBody(activity: LinearAgentSessionActivity): activity is ConversationActivity {
  return "body" in activity.content;
}

function activityMessage(activity: ConversationActivity): LinearIssueContextMessage {
  return {
    id: activity.id,
    content: activity.content.body,
    author: activity.user,
    created_at: activity.createdAt,
    kind: activity.content.type,
  };
}

function isBeforeLinearTrigger(entity: { createdAt: string }, beforeCreatedAt: string): boolean {
  const entityAt = Date.parse(entity.createdAt);
  const triggerAt = Date.parse(beforeCreatedAt);
  return Number.isFinite(entityAt) && Number.isFinite(triggerAt) && entityAt < triggerAt;
}

function compareLinearOrder(
  left: { id: string; createdAt: string },
  right: { id: string; createdAt: string },
): number {
  const byCreatedAt = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return byCreatedAt === 0 ? left.id.localeCompare(right.id) : byCreatedAt;
}

function hasSourceTrigger(triggers: readonly { on: string }[], source: string): boolean {
  return triggers.some((trigger) => {
    if (source === "linear.issue") {
      return trigger.on === "linear.issue_entered_scope" || trigger.on === "linear.issue_assigned";
    }
    if (source === "linear.comment") return trigger.on === "linear.comment_created";
    return (
      source === "linear.agent_session" &&
      (trigger.on === "linear.agent_session_created" ||
        trigger.on === "linear.agent_session_prompted")
    );
  });
}

/** Verbatim: Linear's own prompt context for a new session, the human's message for a follow-up. */
function promptForEvent(event: NormalizedLinearEvent): string {
  if (event.type === "comment") return event.comment.body;
  if (event.type === "issue") return issueText(event.issue);
  if (event.activity !== null) return event.activity.body;
  if (event.promptContext !== null) return event.promptContext;
  if (event.session.issue === null) throw new Error("Linear session prompt unavailable");
  return issueText(event.session.issue);
}

function issueText(issue: { title: string; description: string | null }): string {
  return issue.description === null ? issue.title : `${issue.title}\n\n${issue.description}`;
}

function buildLinearIssueContext(
  event: NormalizedLinearIssueEvent | NormalizedLinearCommentEvent,
  deliveryId: string,
  connectionId: string | null | undefined,
): LinearIssueEventContext {
  const issue = event.type === "issue" ? event.issue : event.issue;
  if (issue === null) throw new Error("Linear event issue context unavailable");
  return {
    event_type: event.type,
    action: event.action,
    delivery_id: deliveryId,
    connection_id: connectionId ?? null,
    organization: { id: event.organizationId },
    actor: event.actor,
    issue: {
      id: issue.id,
      ...(issue.identifier === undefined ? {} : { identifier: issue.identifier }),
      title: issue.title,
      description: issue.description,
      ...(issue.url === undefined ? {} : { url: issue.url }),
      project: issue.projectId === null ? null : { id: issue.projectId },
      state: issue.stateId === null ? null : { id: issue.stateId },
      assignee: issue.assigneeId === null ? null : { id: issue.assigneeId },
      label_ids: issue.labelIds,
    },
    comment: event.type === "comment" ? { id: event.comment.id, body: event.comment.body } : null,
    trigger_thread_context:
      event.occurredAt === undefined
        ? { status: "unavailable" }
        : {
            status: "deferred",
            issue: { id: issue.id },
            before: { created_at: event.occurredAt },
          },
  };
}

function buildLinearSessionContext(
  event: NormalizedLinearAgentSessionEvent,
  deliveryId: string,
  connectionId: string | null | undefined,
  authority: CompiledLinearAuthority | null,
): LinearSessionEventContext {
  const { session, activity } = event;
  if (session.issue === null) throw new Error("Linear session has no issue");
  const actor = activity === null ? session.creator : activity.user;
  return {
    event_type: "agent_session",
    action: event.action,
    delivery_id: deliveryId,
    ...(event.transportDeliveryId === undefined
      ? {}
      : { transport_delivery_id: event.transportDeliveryId }),
    connection_id: connectionId ?? null,
    organization: { id: event.organizationId },
    app_user: { id: event.appUserId },
    actor: actor === null ? null : contextUser(actor),
    source: linearSessionSource(event),
    session: {
      id: session.id,
      status: session.status,
      url: session.url,
      created_at: session.createdAt,
    },
    issue: {
      id: session.issue.id,
      identifier: session.issue.identifier,
      title: session.issue.title,
      description: session.issue.description,
      url: session.issue.url,
      project: null,
      state: null,
      assignee: null,
      label_ids: [],
    },
    team: session.issue.team,
    comment: session.comment === null ? null : contextThreadComment(session.comment),
    source_comment_id: session.sourceCommentId,
    creator: session.creator === null ? null : contextUser(session.creator),
    prompt_context: event.promptContext,
    guidance: event.guidance.map((guidance) => ({
      body: guidance.body,
      ...(guidance.origin.type === "Team"
        ? {
            origin: "team" as const,
            ...(guidance.origin.team === undefined ? {} : { team: guidance.origin.team }),
          }
        : { origin: "organization" as const }),
    })),
    previous_comments: event.previousComments.map(contextThreadComment),
    activity:
      activity === null
        ? null
        : {
            id: activity.id,
            body: activity.body,
            created_at: activity.createdAt,
            signal: activity.signal,
            signal_metadata:
              activity.signalMetadata === null
                ? null
                : asTriggerContextValue(activity.signalMetadata),
            source_comment_id: activity.sourceCommentId,
            user: contextUser(activity.user),
          },
    authority,
    trigger_thread_context: {
      status: "deferred",
      session: { id: session.id },
      before:
        activity === null
          ? { created_at: session.createdAt, activity_id: null }
          : { created_at: activity.createdAt, activity_id: activity.id },
    },
  };
}

function contextUser(user: { id: string; name?: string | undefined }): LinearContextUser {
  return { id: user.id, ...(user.name === undefined ? {} : { name: user.name }) };
}

function contextThreadComment(comment: {
  id: string;
  body: string;
  userId: string | null;
}): LinearContextThreadComment {
  return { id: comment.id, body: comment.body, user_id: comment.userId };
}
