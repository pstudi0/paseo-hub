import { z } from "zod";
import type { CompiledLinearMirror } from "../../config/linear-authority.js";
import type { ExecutionControl } from "../../daemons/execution-control.js";
import type {
  Database,
  LinearAgentSessionRecord,
  LinearPendingPermission,
} from "../../db/types.js";
import { reportFailure } from "../../failures/index.js";
import type { LinearPlanStep } from "../../providers/linear/client.js";
import type { AgentStreamNotification } from "../index.js";
import { deriveLinearActivityId } from "./activity-id.js";
import type { LinearOutboundActivity } from "./activity-queue.js";
import { LINEAR_COPY } from "./copy.js";
import type { LinearOutputContext, LinearTriggerContext } from "./provider.js";
import {
  ephemeralThought,
  type LinearSessionCoordinator,
  type LinearSessionTarget,
} from "./session-coordinator.js";

export const LINEAR_MIRROR_RESULT_MAX_CHARS = 500;
export const LINEAR_MIRROR_THOUGHT_MAX_CHARS = 2_000;
const PARAMETER_MAX_CHARS = 200;
const RECORD_CACHE_TTL_MS = 5_000;

const DEFAULT_MIRROR: CompiledLinearMirror = {
  actions: true,
  thoughts: "summary",
  plan: true,
  permissions: true,
};

/** Local mirrors of the Paseo protocol shapes the Hub only types loosely. */
export const LinearMirrorToolCallSchema = z
  .object({
    type: z.literal("tool_call"),
    callId: z.string(),
    name: z.string(),
    status: z.enum(["running", "completed", "failed", "canceled"]),
    detail: z.object({ type: z.string() }).passthrough().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

export const LinearMirrorTodoSchema = z
  .object({
    type: z.literal("todo"),
    items: z.array(
      z
        .object({
          text: z.string(),
          completed: z.boolean().optional(),
          status: z.enum(["pending", "in_progress", "completed"]).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const LinearMirrorPermissionRequestSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(["tool", "plan", "question", "mode", "other"]).optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    suggestions: z.array(z.record(z.string(), z.unknown())).optional(),
    actions: z
      .array(
        z
          .object({ id: z.string(), label: z.string(), behavior: z.enum(["allow", "deny"]) })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export type LinearMirrorDatabase = Pick<
  Database,
  "findLinearAgentSession" | "updateLinearAgentSession" | "takeLinearPendingPrompts"
>;

export interface LinearMirror {
  observe(input: AgentStreamNotification<LinearTriggerContext, LinearOutputContext>): Promise<void>;
  /** Drops the cached record of a finished execution. */
  forget(executionId: string): void;
}

interface CachedRecord {
  record: LinearAgentSessionRecord;
  readAt: number;
}

/**
 * Turns the daemon's agent stream into Linear activities: actions, thoughts, plan, the fallback
 * response at the end of a turn, and permission elicitations. Only turn boundaries and permissions
 * touch the database; tool calls and messages are mirrored from a short-lived cached record.
 */
interface MirrorContext {
  input: AgentStreamNotification<LinearTriggerContext, LinearOutputContext>;
  linear: Extract<LinearTriggerContext["event"]["linear"], { event_type: "agent_session" }>;
  target: LinearSessionTarget;
  record: LinearAgentSessionRecord;
  mirror: CompiledLinearMirror;
}

interface MirrorDependencies {
  coordinator: Pick<
    LinearSessionCoordinator,
    "emit" | "updateSession" | "publishPullRequest" | "reopen"
  >;
  database: LinearMirrorDatabase;
  control: Pick<ExecutionControl, "daemonPermissions" | "readWorkspacePullRequest" | "steer">;
  now?: () => number;
}

/**
 * Turns the daemon's agent stream into Linear activities: actions, thoughts, plan, the fallback
 * response at the end of a turn, and permission elicitations. Only turn boundaries and permissions
 * touch the database; tool calls and messages are mirrored from a short-lived cached record.
 */
export function createLinearMirror(options: MirrorDependencies): LinearMirror {
  const records = new Map<string, CachedRecord>();
  const turns = new Map<string, number>();
  const lastMessages = new Map<string, string>();
  /** Tool calls already mirrored per execution, as `${callId}:start|end`: a streaming tool
   *  repeats its `running` item and Linear rejects a second activity with the same id. */
  const mirroredCalls = new Map<string, Set<string>>();
  const now = options.now ?? Date.now;

  async function currentRecord(
    executionId: string,
    sessionId: string,
    fresh: boolean,
  ): Promise<LinearAgentSessionRecord | undefined> {
    const cached = records.get(executionId);
    if (!fresh && cached !== undefined && now() - cached.readAt < RECORD_CACHE_TTL_MS) {
      return cached.record;
    }
    const record = await options.database.findLinearAgentSession(sessionId);
    if (record === undefined) return undefined;
    records.set(executionId, { record, readAt: now() });
    return record;
  }

  function turnKey(context: MirrorContext): string {
    const turnId = Reflect.get(context.input.event, "turnId");
    if (typeof turnId === "string") return turnId;
    return `${context.input.executionId}:${String(turns.get(context.input.executionId) ?? 0)}`;
  }

  async function handleTurnStarted(context: MirrorContext): Promise<void> {
    const { executionId } = context.input;
    turns.set(executionId, (turns.get(executionId) ?? 0) + 1);
    lastMessages.delete(executionId);
    const updated = await options.database.updateLinearAgentSession(context.target.sessionId, {
      respondedAt: null,
      lastAssistantMessage: null,
      mirrorStatus: "active",
    });
    if (updated !== undefined) records.set(executionId, { record: updated, readAt: now() });
  }

  async function handleTurnCompleted(context: MirrorContext): Promise<void> {
    if (context.record.respondedAt === null) {
      const body = lastMessages.get(context.input.executionId) ?? LINEAR_COPY.fallbackResponse;
      await options.coordinator.emit(context.target, {
        kind: "activity",
        id: deriveLinearActivityId(`${context.target.sessionId}:turn:${turnKey(context)}:response`),
        content: { type: "response", body },
        ephemeral: false,
      });
    }
    await publishPullRequestIfAny(context.input, context.target, context.linear, options);
  }

  function handleAssistantMessage(context: MirrorContext, text: string): void {
    const body = truncate(text, LINEAR_MIRROR_THOUGHT_MAX_CHARS);
    lastMessages.set(context.input.executionId, body);
    if (context.mirror.thoughts === "none") return;
    void options.coordinator.emit(
      context.target,
      context.mirror.thoughts === "summary"
        ? ephemeralThought(body)
        : { kind: "activity", content: { type: "thought", body }, ephemeral: false },
    );
  }

  async function handlePermissionRequested(
    context: MirrorContext,
    request: z.infer<typeof LinearMirrorPermissionRequestSchema>,
  ): Promise<void> {
    const { target, input } = context;
    const title = request.title ?? request.name;
    if (request.kind === "question") {
      void options.coordinator.emit(target, {
        kind: "activity",
        content: { type: "thought", body: LINEAR_COPY.questionInPaseo(title) },
        ephemeral: false,
      });
      return;
    }
    const permissions = await options.control.daemonPermissions(input.daemonId);
    if (!permissions.includes("workspace.write")) {
      void options.coordinator.emit(target, {
        kind: "activity",
        content: { type: "thought", body: LINEAR_COPY.permissionWaitingWithoutAuthority(title) },
        ephemeral: false,
      });
      return;
    }
    const choices = permissionChoices(request);
    const activityId = deriveLinearActivityId(`${target.sessionId}:permission:${request.id}`);
    await options.database.updateLinearAgentSession(target.sessionId, {
      pendingPermission: {
        requestId: request.id,
        agentId: input.agentId,
        executionId: input.executionId,
        activityId,
        options: choices,
        suggestions: request.suggestions ?? [],
      },
      mirrorStatus: "awaitingInput",
    });
    records.delete(input.executionId);
    void options.coordinator.emit(target, {
      kind: "activity",
      id: activityId,
      content: { type: "elicitation", body: `${title}\n\n${request.description ?? ""}`.trim() },
      ephemeral: false,
      signal: "select",
      signalMetadata: { options: choices.map(({ label, value }) => ({ label, value })) },
    });
  }

  async function handlePermissionResolved(
    context: MirrorContext,
    requestId: string,
  ): Promise<void> {
    const { target, input, record } = context;
    if (record.pendingPermission?.requestId !== requestId) return;
    await options.database.updateLinearAgentSession(target.sessionId, {
      pendingPermission: null,
      respondedAt: null,
      mirrorStatus: "active",
    });
    records.delete(input.executionId);
    void options.coordinator.emit(target, ephemeralThought(LINEAR_COPY.permissionResolved));
    const prompts = await options.database.takeLinearPendingPrompts(target.sessionId);
    for (const prompt of prompts) {
      try {
        await options.control.steer(input.executionId, prompt.activityId, prompt.body);
      } catch (error) {
        reportFailure(error, {
          component: "triggers",
          operation: "linear.follow_up.steer",
          provider: "linear",
        });
      }
    }
  }

  function handleTimeline(context: MirrorContext, item: Record<string, unknown>): void {
    const { target, mirror } = context;
    if (item["type"] === "tool_call") {
      if (!mirror.actions) return;
      const parsed = LinearMirrorToolCallSchema.safeParse(item);
      if (!parsed.success) return reportParse(parsed.error, target);
      if (isHubTool(parsed.data.name)) return;
      const phase = parsed.data.status === "running" ? "start" : "end";
      const seen = mirroredCalls.get(context.input.executionId) ?? new Set<string>();
      if (seen.has(`${parsed.data.callId}:${phase}`)) return;
      seen.add(`${parsed.data.callId}:${phase}`);
      mirroredCalls.set(context.input.executionId, seen);
      void options.coordinator.emit(target, toolCallActivity(target, parsed.data));
      return;
    }
    if (item["type"] === "assistant_message") {
      const text = typeof item["text"] === "string" ? item["text"].trim() : "";
      if (text.length > 0) handleAssistantMessage(context, text);
      return;
    }
    if (item["type"] === "todo") {
      if (!mirror.plan) return;
      const parsed = LinearMirrorTodoSchema.safeParse(item);
      if (!parsed.success) return reportParse(parsed.error, target);
      void options.coordinator.updateSession(target, {
        plan: parsed.data.items.map(planStep),
        coalesceKey: "plan",
      });
    }
  }

  return {
    async observe(input) {
      const linear = input.triggerContext.event.linear;
      if (linear.event_type !== "agent_session") return;
      const target: LinearSessionTarget = {
        sessionId: linear.session.id,
        linearOrganizationId: linear.organization.id,
      };
      const event = input.event;
      const fresh = event.type !== "timeline";
      const record = await currentRecord(input.executionId, target.sessionId, fresh);
      if (record === undefined || record.currentExecutionId !== input.executionId) return;
      if (record.stopRequestedAt !== null && input.observedAt > record.stopRequestedAt) return;
      const context: MirrorContext = {
        input,
        linear,
        target,
        record,
        mirror: linear.authority?.mirror ?? DEFAULT_MIRROR,
      };
      switch (event.type) {
        case "timeline":
          return handleTimeline(context, event.item);
        case "turn_started":
          return handleTurnStarted(context);
        case "turn_completed":
          return handleTurnCompleted(context);
        case "turn_failed":
          void options.coordinator.emit(target, {
            kind: "activity",
            id: deriveLinearActivityId(`${target.sessionId}:turn:${turnKey(context)}:failed`),
            content: { type: "thought", body: LINEAR_COPY.turnFailed(event.error) },
            ephemeral: false,
          });
          return;
        case "permission_requested": {
          if (!context.mirror.permissions) return;
          const parsed = LinearMirrorPermissionRequestSchema.safeParse(event.request);
          if (!parsed.success) return reportParse(parsed.error, target);
          return handlePermissionRequested(context, parsed.data);
        }
        case "permission_resolved":
          return handlePermissionResolved(context, event.requestId);
        default:
          return;
      }
    },
    forget(executionId) {
      records.delete(executionId);
      turns.delete(executionId);
      lastMessages.delete(executionId);
      mirroredCalls.delete(executionId);
    },
  };
}

function planStep(todo: {
  text: string;
  completed?: boolean | undefined;
  status?: "pending" | "in_progress" | "completed" | undefined;
}): LinearPlanStep {
  if (todo.completed === true || todo.status === "completed") {
    return { content: todo.text, status: "completed" };
  }
  return { content: todo.text, status: todo.status === "in_progress" ? "inProgress" : "pending" };
}

function permissionChoices(
  request: z.infer<typeof LinearMirrorPermissionRequestSchema>,
): LinearPendingPermission["options"] {
  if (request.actions !== undefined && request.actions.length > 0) {
    return request.actions.map((action) => ({
      value: action.id,
      label: action.label,
      behavior: action.behavior,
      selectedActionId: action.id,
    }));
  }
  const session =
    (request.suggestions?.length ?? 0) > 0
      ? [
          {
            value: "allow_session",
            label: "Allow for this session",
            behavior: "allow" as const,
            forSession: true,
          },
        ]
      : [];
  return [
    { value: "allow", label: "Allow", behavior: "allow" },
    ...session,
    { value: "deny", label: "Deny", behavior: "deny" },
  ];
}

function toolCallActivity(
  target: LinearSessionTarget,
  item: z.infer<typeof LinearMirrorToolCallSchema>,
): LinearOutboundActivity {
  const action = describeToolCall(item);
  const running = item.status === "running";
  return {
    kind: "activity",
    id: deriveLinearActivityId(
      `${target.sessionId}:tool:${item.callId}:${running ? "start" : "end"}`,
    ),
    content: {
      type: "action",
      action: action.verb,
      parameter: action.parameter,
      ...(running ? {} : { result: toolResult(item) }),
    },
    ephemeral: running,
  };
}

async function publishPullRequestIfAny(
  input: AgentStreamNotification<LinearTriggerContext, LinearOutputContext>,
  target: LinearSessionTarget,
  linear: Extract<LinearTriggerContext["event"]["linear"], { event_type: "agent_session" }>,
  options: {
    coordinator: Pick<LinearSessionCoordinator, "publishPullRequest">;
    control: Pick<ExecutionControl, "readWorkspacePullRequest">;
  },
): Promise<void> {
  let pullRequest: { url: string; title?: string } | undefined;
  try {
    pullRequest = await options.control.readWorkspacePullRequest(input.executionId);
  } catch (error) {
    reportFailure(error, {
      component: "triggers",
      operation: "linear.pull_request.detect",
      provider: "linear",
    });
    return;
  }
  if (pullRequest === undefined) return;
  const selector = linear.authority?.onPullRequest;
  await options.coordinator.publishPullRequest({
    target,
    issueId: linear.issue.id,
    url: pullRequest.url,
    ...(pullRequest.title === undefined ? {} : { title: pullRequest.title }),
    transition:
      selector !== undefined && linear.creator !== null
        ? { teamId: linear.team.id, selector }
        : undefined,
  });
}

function reportParse(error: unknown, target: LinearSessionTarget): void {
  reportFailure(
    error,
    { component: "triggers", operation: "linear.mirror.parse", provider: "linear" },
    { diagnostic: { sessionId: target.sessionId } },
  );
}

function isHubTool(name: string): boolean {
  return name.startsWith("hub.") || name.startsWith("mcp__hub__");
}

const TOOL_VERBS: Readonly<Record<string, { verb: string; keys: readonly string[] }>> = {
  shell: { verb: "Running", keys: ["command"] },
  read: { verb: "Reading", keys: ["filePath"] },
  edit: { verb: "Editing", keys: ["filePath"] },
  write: { verb: "Editing", keys: ["filePath"] },
  search: { verb: "Searching", keys: ["query"] },
  fetch: { verb: "Fetching", keys: ["url"] },
  sub_agent: { verb: "Delegating", keys: ["description", "subAgentType"] },
  plain_text: { verb: "", keys: ["text", "label"] },
  plan: { verb: "Planning", keys: ["text"] },
  worktree_setup: { verb: "Preparing", keys: ["branchName"] },
};

/** Verb and parameter derived from `detail.type`; tool names vary per Paseo provider. */
export function describeToolCall(item: {
  name: string;
  detail?: Record<string, unknown> | undefined;
}): { verb: string; parameter: string } {
  const detail = item.detail ?? {};
  const type = typeof detail["type"] === "string" ? detail["type"] : "unknown";
  const shortName = item.name.split(/__|\./u).pop() ?? item.name;
  const mapping = TOOL_VERBS[type];
  const text = (key: string): string | undefined => {
    const value = detail[key];
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
  };
  let parameter: string | undefined;
  for (const key of mapping?.keys ?? []) {
    parameter = text(key);
    if (parameter !== undefined) break;
  }
  if (type === "search" && parameter !== undefined && text("toolName") !== undefined) {
    parameter = `${text("toolName") ?? ""}: ${parameter}`;
  }
  const firstLine = (parameter ?? item.name).split(/\r?\n/u, 1)[0] ?? item.name;
  return {
    verb: mapping === undefined || mapping.verb === "" ? shortName : mapping.verb,
    parameter: truncate(firstLine.trim() || item.name, PARAMETER_MAX_CHARS),
  };
}

function toolResult(item: { status: string; error?: unknown }): string {
  if (item.status === "failed") {
    return truncate(`Failed: ${errorText(item.error)}`, LINEAR_MIRROR_RESULT_MAX_CHARS);
  }
  if (item.status === "canceled") return "Canceled";
  return "Done";
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message: unknown = error.message;
    if (typeof message === "string") return message;
  }
  return "unknown error";
}

function truncate(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join("")}…`;
}
