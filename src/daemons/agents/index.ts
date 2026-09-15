import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  HubExecutionAgentStreamEventSchema,
  HubExecutionAgentSnapshotSchema,
} from "../../hub/protocol.js";
import type { DaemonCreateAgentOptions, DaemonAgentStreamEvent } from "../protocol.js";
import { DaemonResponseLostError } from "../protocol.js";

/** How long a permission answer waits for the daemon to confirm it before reporting "unconfirmed". */
export const PERMISSION_CONFIRM_MS = 30_000;
const WORKSPACE_PAGE_SIZE = 200;

const SnapshotSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  status: HubExecutionAgentSnapshotSchema.shape.status,
  archivedAt: z.unknown().optional(),
  pendingPermissions: z.array(z.object({ id: z.string() }).passthrough()).default([]),
});
export type AgentSnapshot = z.infer<typeof SnapshotSchema>;
export type AgentEvent =
  | { type: "agent_update"; agent: AgentSnapshot; timestamp: string }
  | { type: "agent_stream"; agentId: string; event: DaemonAgentStreamEvent; timestamp: string };

/** Mirrors Paseo's `AgentPermissionResponseSchema` (protocol `messages.ts`). */
export type AgentPermissionResponse =
  | {
      behavior: "allow";
      selectedActionId?: string;
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: Record<string, unknown>[];
    }
  | { behavior: "deny"; selectedActionId?: string; message?: string; interrupt?: boolean };

export type WorkspaceInspection =
  | { kind: "active" }
  | { kind: "archived" }
  | { kind: "missing" }
  | { kind: "unrecoverable"; reason: string };

const WorkspaceSnapshotSchema = z
  .object({
    id: z.string(),
    githubRuntime: z
      .object({
        pullRequest: z
          .object({ url: z.string(), number: z.number().optional(), title: z.string() })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

export interface AgentConnection {
  create(
    key: string,
    options: DaemonCreateAgentOptions,
    timeoutMs?: number,
  ): Promise<AgentSnapshot>;
  get(agentId: string): Promise<AgentSnapshot>;
  send(agentId: string, messageId: string, text: string, timeoutMs?: number): Promise<void>;
  restore(workspaceId: string, timeoutMs?: number): Promise<boolean>;
  control(
    agentId: string,
    workspaceId: string,
    action: "interrupt" | "archive" | "archive_agent",
  ): Promise<void>;
  inspectWorkspace(workspaceId: string): Promise<WorkspaceInspection>;
  readWorkspace(workspaceId: string): Promise<WorkspaceSnapshot | undefined>;
  /** "unconfirmed" when neither the daemon's reply nor its stream confirmed the answer in time. */
  respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<"resolved" | "unconfirmed">;
  watch(agentId: string, listener: (event: AgentEvent) => void): Promise<() => void>;
}

const EnvelopeSchema = z.object({
  type: z.literal("session"),
  message: z.object({
    type: z.string(),
    payload: z.record(z.string(), z.unknown()),
  }),
});
const ResultSchema = z
  .object({ error: z.string().nullable().optional(), accepted: z.boolean().optional() })
  .passthrough();
const RecoveryStateSchema = z.object({ kind: z.string(), reason: z.string().optional() });
const WorkspacePageSchema = z.object({
  entries: z.array(z.unknown()),
  pageInfo: z.object({ nextCursor: z.string().nullable() }).passthrough(),
});

export class DaemonAgentError extends Error {
  /** The daemon's `rpc_error` code (`access_denied`, `handler_error`, ...) when it sent one. */
  readonly code: string | undefined;
  constructor(message: string, options: { code?: string } = {}) {
    super(message);
    this.code = options.code;
  }
}

/** The ordinary daemon protocol. This channel knows nothing about Hub executions or triggers. */
export class DaemonAgents implements AgentConnection {
  private supported = false;
  private readonly pending = new Map<
    string,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  private observing = false;
  constructor(
    private readonly sendFrame: (frame: string) => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  receive(value: unknown): boolean {
    const envelope = EnvelopeSchema.safeParse(value);
    if (!envelope.success) return false;
    const { type, payload } = envelope.data.message;
    if (type === "server_info" || (type === "status" && payload["status"] === "server_info")) {
      const features = z
        .object({ hubAgentRpc: z.literal(true), agentRequestReceipts: z.literal(true) })
        .safeParse(payload["features"]);
      this.supported = features.success;
      return false;
    }
    const requestId = payload["requestId"];
    const pending = typeof requestId === "string" ? this.pending.get(requestId) : undefined;
    if (pending) {
      if (type === "rpc_error" || payload["status"] === "agent_create_failed") {
        const code = z.string().optional().catch(undefined).parse(payload["code"]);
        pending.reject(
          new DaemonAgentError(
            z.string().catch("Daemon request rejected").parse(payload["error"]),
            code === undefined ? {} : { code },
          ),
        );
      } else pending.resolve(payload);
      return true;
    }
    if (type === "agent_update" && payload["kind"] === "upsert") {
      const agent = SnapshotSchema.safeParse(payload["agent"]);
      if (agent.success)
        this.emit(agent.data.id, { type, agent: agent.data, timestamp: this.now().toISOString() });
      return true;
    }
    if (type === "agent_stream") {
      const stream = z
        .object({
          agentId: z.string(),
          timestamp: z.string(),
          event: HubExecutionAgentStreamEventSchema,
        })
        .safeParse(payload);
      if (stream.success)
        this.emit(stream.data.agentId, {
          type,
          ...stream.data,
          timestamp: this.now().toISOString(),
        });
      return true;
    }
    return false;
  }

  close(): void {
    for (const pending of this.pending.values()) pending.reject(new DaemonResponseLostError());
    this.pending.clear();
    this.listeners.clear();
  }

  async create(
    key: string,
    options: DaemonCreateAgentOptions,
    timeoutMs?: number,
  ): Promise<AgentSnapshot> {
    const response = await this.request(
      {
        type: "create_agent_request",
        idempotencyKey: key,
        config: {
          provider: options.provider,
          cwd: options.cwd,
          model: options.model,
          modeId: options.mode,
          thinkingOptionId: options.thinkingOptionId,
          providerOptions: options.providerOptions,
          mcpServers: options.mcpServers,
          toolPolicy: options.toolPolicy,
        },
        env: options.env,
        worktree: options.worktree,
        ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
        ...(options.labels === undefined ? {} : { labels: options.labels }),
      },
      timeoutMs,
    );
    return SnapshotSchema.parse(response["agent"]);
  }
  async get(agentId: string): Promise<AgentSnapshot> {
    const response = await this.request({ type: "fetch_agent_request", agentId });
    if (response["agent"] === null)
      throw new DaemonAgentError(
        "Continuation agent was deleted; use a new key or choose a new agent",
      );
    return SnapshotSchema.parse(response["agent"]);
  }
  async send(agentId: string, messageId: string, text: string, timeoutMs?: number): Promise<void> {
    await this.request(
      {
        type: "send_agent_message_request",
        agentId,
        messageId,
        text,
        activeTurnBehavior: "steer",
      },
      timeoutMs,
    );
  }
  async inspectWorkspace(workspaceId: string): Promise<WorkspaceInspection> {
    const result = await this.request({ type: "workspace.recovery.inspect.request", workspaceId });
    const state = RecoveryStateSchema.parse(result["state"]);
    if (state.kind === "recoverable") return { kind: "archived" };
    if (state.reason === "workspace_not_archived") return { kind: "active" };
    if (state.reason === "workspace_not_found") return { kind: "missing" };
    return { kind: "unrecoverable", reason: state.reason ?? state.kind };
  }
  async restore(workspaceId: string, timeoutMs?: number): Promise<boolean> {
    const inspection = await this.inspectWorkspace(workspaceId);
    if (inspection.kind === "active") return false;
    if (inspection.kind !== "archived")
      throw new DaemonAgentError(
        "Workspace cannot be restored; inspect its recovery state in Paseo",
      );
    await this.request({ type: "workspace.recovery.restore.request", workspaceId }, timeoutMs);
    return true;
  }
  async readWorkspace(workspaceId: string): Promise<WorkspaceSnapshot | undefined> {
    let cursor: string | undefined;
    do {
      const result = await this.request({
        type: "fetch_workspaces_request",
        page: { limit: WORKSPACE_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
        sort: [{ key: "activity_at", direction: "desc" }],
      });
      const page = WorkspacePageSchema.parse(result);
      for (const entry of page.entries) {
        const workspace = WorkspaceSnapshotSchema.safeParse(entry);
        if (workspace.success && workspace.data.id === workspaceId) return workspace.data;
      }
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return undefined;
  }
  async control(
    agentId: string,
    workspaceId: string,
    action: "interrupt" | "archive" | "archive_agent",
  ): Promise<void> {
    if (action === "archive") {
      await this.request({ type: "archive_workspace_request", workspaceId });
      return;
    }
    await this.request(
      action === "archive_agent"
        ? { type: "archive_agent_request", agentId }
        : { type: "cancel_agent_request", agentId },
    );
  }
  /**
   * The daemon correlates its answer on this frame's `requestId`: `agent_permission_resolved`
   * (modern sockets) or `rpc_error` on refusal, and every socket also streams `permission_resolved`
   * for the agent. Either confirmation resolves; silence past the deadline is "unconfirmed".
   * One answer per permission is in flight at a time: the frame is correlated on the permission
   * id, so a second concurrent answer could not be told apart from the first.
   */
  async respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<"resolved" | "unconfirmed"> {
    if (this.pending.has(requestId))
      throw new DaemonAgentError(`Permission answer already in flight: ${requestId}`);
    let unlisten = (): void => {};
    const observed = new Promise<"resolved">((resolve) => {
      unlisten = this.listen(agentId, (event) => {
        if (
          event.type === "agent_stream" &&
          event.event.type === "permission_resolved" &&
          event.event.requestId === requestId
        )
          resolve("resolved");
      });
    });
    const sent = this.correlate(
      { type: "agent_permission_response", agentId, requestId, response },
      PERMISSION_CONFIRM_MS,
      requestId,
    );
    const replied = sent.result.then(
      () => "resolved" as const,
      (error: unknown) => {
        if (error instanceof DaemonResponseLostError) return "unconfirmed" as const;
        throw error;
      },
    );
    // The stream may confirm first; the reply's later rejection must not surface unhandled.
    replied.catch(() => undefined);
    try {
      return await Promise.race([observed, replied]);
    } finally {
      unlisten();
      // Whichever confirmation won, the daemon owes nothing more on this request id.
      sent.forget();
    }
  }
  async watch(agentId: string, listener: (event: AgentEvent) => void): Promise<() => void> {
    const unlisten = this.listen(agentId, listener);
    try {
      if (!this.observing) {
        await this.request({
          type: "fetch_agents_request",
          subscribe: { subscriptionId: "hub-continuation" },
        });
        this.observing = true;
      }
      await this.request({
        type: "agent.timeline.set_subscription.request",
        agentIds: [...this.listeners.keys()],
      });
    } catch (error) {
      unlisten();
      throw error;
    }
    return unlisten;
  }
  private listen(agentId: string, listener: (event: AgentEvent) => void): () => void {
    const listeners = this.listeners.get(agentId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(agentId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.listeners.get(agentId) === listeners)
        this.listeners.delete(agentId);
    };
  }
  private emit(agentId: string, event: AgentEvent): void {
    for (const listener of this.listeners.get(agentId) ?? []) listener(event);
  }
  private async request(
    message: Record<string, unknown>,
    timeoutMs = 30_000,
    requestId: string = randomUUID(),
  ): Promise<Record<string, unknown>> {
    return this.correlate(message, timeoutMs, requestId).result;
  }
  /**
   * Sends a correlated request. `result` settles on the daemon's reply or the timeout; `forget`
   * drops the correlation and its timer early, after which the reply is ignored and `result`
   * never settles. A `requestId` already in flight is refused rather than silently replaced.
   */
  private correlate(
    message: Record<string, unknown>,
    timeoutMs: number,
    requestId: string,
  ): { result: Promise<Record<string, unknown>>; forget: () => void } {
    if (!this.supported) {
      return {
        result: Promise.reject(new DaemonAgentError("Update the Paseo daemon to run Hub agents")),
        forget: () => {},
      };
    }
    if (this.pending.has(requestId)) {
      return {
        result: Promise.reject(new DaemonAgentError(`Request already in flight: ${requestId}`)),
        forget: () => {},
      };
    }
    let forget = (): void => {};
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new DaemonResponseLostError()), timeoutMs);
      const entry = { resolve, reject };
      forget = () => {
        clearTimeout(timeout);
        if (this.pending.get(requestId) === entry) this.pending.delete(requestId);
      };
      this.pending.set(requestId, entry);
      this.sendFrame(JSON.stringify({ type: "session", message: { ...message, requestId } }));
    })
      .finally(forget)
      .then((raw) => {
        const parsed = ResultSchema.parse(raw);
        if (parsed.error || parsed.accepted === false)
          throw new DaemonAgentError(parsed.error ?? "Daemon request rejected");
        return raw;
      });
    return { result, forget: () => forget() };
  }
}
