import { parseConnectionTemplate } from "../config/connection-template.js";
import { createHash } from "node:crypto";
import type { Database, AgentExecutionRecord } from "../db/types.js";
import {
  DEFAULT_STARTUP_TIMEOUT_MS,
  type LaunchMachineIntent,
} from "../dispatcher/launch-machine-intent.js";
import type { DaemonCreateAgentOptions } from "../daemons/protocol.js";
import type { AgentConnection, AgentEvent } from "../daemons/agents/index.js";
import {
  executionToolDefinitions,
  type OutputExecutorRegistry,
} from "../execution-capabilities/outputs.js";
import {
  deriveAgentExecutionCompletionToken,
  hashAgentExecutionCompletionToken,
} from "../agent-executions/completion-token.js";
import { reportFailure } from "../failures/index.js";
import type {
  AgentSessionRecord,
  AgentSessionWorkspaceAction,
  AgentSessionWorkspaceResolution,
} from "./types.js";
export type {
  AgentSessionRecord,
  AgentSessionAction,
  AgentSessionWorkspaceAction,
  AgentSessionWorkspaceResolution,
} from "./types.js";

export class AgentSessionError extends Error {}

export interface AgentSessionWorkspaceOutcome {
  action: AgentSessionWorkspaceAction;
  unrecoverableReason?: string;
}

export interface AgentSessionDispatchResult {
  agentId: string;
  workspaceId: string;
  unsubscribe: () => void;
  action: "created" | "continued" | "restored";
  workspace: AgentSessionWorkspaceOutcome;
}

/** Owns session selection, delivery, and cleanup under the same existing database lock. */
export class AgentSessions {
  constructor(
    private readonly database: Database,
    private readonly secret: string,
    private readonly publicBaseUrl: string,
    private readonly outputs: OutputExecutorRegistry,
    private readonly now: () => number = Date.now,
  ) {}

  async dispatch(input: {
    executionId: string;
    intent: LaunchMachineIntent;
    connection: AgentConnection;
    createOptions: () => Promise<DaemonCreateAgentOptions>;
    onEvent: (event: AgentEvent) => void;
  }): Promise<AgentSessionDispatchResult> {
    const incoming = await this.database.findAgentExecutionById(input.executionId);
    if (!incoming || !isActive(incoming)) throw new AgentSessionError("execution_terminal");
    const policy = input.intent.continuation;
    const startupTimeoutMs = input.intent.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const continuationKey = policy?.key ?? null;
    const workspaceKey = policy?.workspaceKey ?? null;
    const projectId = input.intent.projectId;
    // One dispatch lock, never nested: every session of a workspace key serializes on the
    // workspace lock (dispatch, control, releaseAuthority), so no inner workspace lock is needed.
    // Each held lock costs a pooled Postgres connection (`pg_advisory_lock` on `withConnection`).
    const lockId =
      workspaceKey !== null
        ? workspaceLockId(projectId, workspaceKey)
        : deriveSessionId(projectId, continuationKey ?? `execution:${input.executionId}`);
    const findSession = async () => {
      const execution = await this.database.findAgentExecutionById(input.executionId);
      if (execution?.agentSessionId)
        return this.database.findAgentSession(execution.agentSessionId);
      return continuationKey === null
        ? this.database.findAgentSession(
            deriveSessionId(projectId, `execution:${input.executionId}`),
          )
        : this.database.findAgentSessionByKey(projectId, continuationKey);
    };
    const isFinishedCredentialedSession = async (session: AgentSessionRecord) => {
      const executions = await this.database.listAgentSessionExecutions(session.id);
      return (
        executions.length > 0 &&
        !executions.some(isActive) &&
        executions.some(
          (execution) =>
            execution.launchIntent !== null && hasTemporaryCredentials(execution.launchIntent),
        )
      );
    };
    // External credential minting must not hold a database connection open during shutdown.
    const storedSession = await findSession();
    const options =
      !storedSession || (await isFinishedCredentialedSession(storedSession))
        ? await input.createOptions()
        : undefined;
    const dispatched = await this.database.withAdvisoryLock(`agent-session:${lockId}`, async () => {
      const tools = executionToolDefinitions(
        input.intent.outputSchema,
        this.outputs.materialize(input.intent.allowOutputs, input.intent.outputContext),
      );
      const compatibility = fingerprint({ settings: policy?.compatibility, tools });
      let session = await findSession();
      if (session && (await isFinishedCredentialedSession(session))) {
        // Completion may have raced credential preparation. Retry outside the lock.
        if (!options) return undefined;
        await this.database.saveAgentSession({ ...session, continuationKey: null });
        session = undefined;
      }
      const id = session?.id ?? deriveSessionId(projectId, `execution:${input.executionId}`);
      if (session && session.compatibility !== compatibility) {
        throw new AgentSessionError(
          "Continuation settings differ from the existing agent; use a different key or choose a new agent",
        );
      }
      if (!session) {
        if (!options) return undefined;
        session = this.newSession({ id, intent: input.intent, compatibility, tools, options });
        await this.database.saveAgentSession(session);
      }
      await this.inheritDeadline(id, input.executionId);
      await this.database.attachExecutionToSession(input.executionId, id);
      const materialized = await this.materializeAgent(session, input.connection, startupTimeoutMs);
      await this.database.attachAgentToExecution(
        input.executionId,
        materialized.session.daemonId,
        materialized.agentId,
      );
      await this.database.attachExecutionToSession(input.executionId, id, materialized.action);
      const unsubscribe = await this.deliver(input, materialized.agentId, startupTimeoutMs);
      return {
        agentId: materialized.agentId,
        workspaceId: materialized.workspaceId,
        unsubscribe,
        action: materialized.action,
        workspace: materialized.workspace,
      };
    });
    return dispatched ?? this.dispatch(input);
  }

  private newSession(input: {
    id: string;
    intent: LaunchMachineIntent;
    compatibility: string;
    tools: AgentSessionRecord["tools"];
    options: DaemonCreateAgentOptions;
  }): AgentSessionRecord {
    const { id, intent } = input;
    const policy = intent.continuation;
    const continuationKey = policy?.key ?? null;
    const workspaceKey = policy?.workspaceKey ?? null;
    const token = deriveAgentExecutionCompletionToken(this.secret, `session:${id}`);
    const labels = {
      ...(workspaceKey === null ? {} : { "hub.workspace-key": workspaceKey }),
      ...(continuationKey === null ? {} : { "hub.continuation-key": continuationKey }),
    };
    return {
      id,
      projectId: intent.projectId,
      organizationId: intent.organizationId,
      continuationKey,
      workspaceKey,
      workspaceResolution: null,
      daemonId: intent.environment.daemonId,
      agentId: null,
      workspaceId: null,
      compatibility: input.compatibility,
      tools: input.tools,
      capabilityTokenHash: hashAgentExecutionCompletionToken(token),
      creationOptions: {
        ...input.options,
        ...(Object.keys(labels).length === 0 ? {} : { labels }),
        ...(policy === undefined
          ? {}
          : {
              mcpServers: {
                hub: {
                  type: "http",
                  url: new URL(`/agent-sessions/${id}/mcp`, this.publicBaseUrl).toString(),
                  headers: { Authorization: `Bearer ${token}` },
                },
              },
            }),
      },
    };
  }

  /** A new arrival cannot outlive the earliest deadline among the session's live executions. */
  private async inheritDeadline(sessionId: string, executionId: string): Promise<void> {
    const activeExecutions = (await this.database.listAgentSessionExecutions(sessionId)).filter(
      isActive,
    );
    const deadline = activeExecutions.reduce<number>(
      (earliest, execution) =>
        Math.min(earliest, execution.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY),
      Number.POSITIVE_INFINITY,
    );
    if (Number.isFinite(deadline))
      await this.database.limitAgentExecutionDeadline(executionId, new Date(deadline));
  }

  /** Creates the session's agent when it has none, then makes sure its workspace is live. */
  private async materializeAgent(
    stored: AgentSessionRecord,
    connection: AgentConnection,
    startupTimeoutMs: number,
  ): Promise<{
    session: AgentSessionRecord;
    agentId: string;
    workspaceId: string;
    action: "created" | "continued" | "restored";
    workspace: AgentSessionWorkspaceOutcome;
  }> {
    let session = stored;
    let action: "created" | "continued" | "restored" = "continued";
    let workspace: AgentSessionWorkspaceOutcome = { action: "reused" };
    if (session.agentId === null) {
      session = await this.resolveWorkspace(session, connection, startupTimeoutMs);
      workspace = workspaceOutcome(session.workspaceResolution);
      const agent = await connection.create(session.id, session.creationOptions, startupTimeoutMs);
      session = { ...session, agentId: agent.id, workspaceId: agent.workspaceId };
      await this.database.saveAgentSession(session);
      action = "created";
    }
    if (session.agentId === null || session.workspaceId === null)
      throw new Error("Session agent is missing");
    const agent = await connection.get(session.agentId);
    if (!agent.archivedAt && (agent.status === "closed" || agent.status === "error")) {
      throw new AgentSessionError("agent_interrupted");
    }
    if (agent.archivedAt) {
      await connection.restore(session.workspaceId, startupTimeoutMs);
      action = "restored";
      workspace = { action: "restored" };
    }
    return {
      session,
      agentId: session.agentId,
      workspaceId: session.workspaceId,
      action,
      workspace,
    };
  }

  /**
   * Chooses the daemon workspace of a workspace-keyed session once and persists the choice inside
   * `creationOptions` before the daemon sees a creation request: the daemon fingerprints the
   * request under the session's idempotency key, so a replay after a crash between `create` and
   * `saveAgentSession` must send byte-identical options rather than resolve again.
   */
  private async resolveWorkspace(
    session: AgentSessionRecord,
    connection: AgentConnection,
    startupTimeoutMs: number,
  ): Promise<AgentSessionRecord> {
    if (session.workspaceResolution !== null || session.workspaceKey === null) return session;
    const siblings = await this.database.findAgentSessionsByWorkspaceKey(
      session.projectId,
      session.workspaceKey,
    );
    const candidates = new Set(
      siblings
        .filter(
          (sibling) =>
            sibling.id !== session.id &&
            sibling.daemonId === session.daemonId &&
            sibling.workspaceId !== null,
        )
        .map((sibling) => sibling.workspaceId!),
    );
    let unrecoverableReason: string | undefined;
    let retained: { workspaceId: string; action: "reused" | "restored" } | undefined;
    for (const workspaceId of candidates) {
      const inspection = await connection.inspectWorkspace(workspaceId);
      if (inspection.kind === "active") {
        retained = { workspaceId, action: "reused" };
        break;
      }
      if (inspection.kind === "archived") {
        await connection.restore(workspaceId, startupTimeoutMs);
        retained = { workspaceId, action: "restored" };
        break;
      }
      if (inspection.kind === "missing") continue;
      unrecoverableReason = inspection.reason;
      reportFailure(
        new AgentSessionError(`Workspace cannot be restored: ${inspection.reason}`),
        { operation: "agent_sessions.workspace.restore", component: "agent-sessions" },
        {
          diagnostic: {
            sessionId: session.id,
            workspaceKey: session.workspaceKey,
            workspaceId,
            reason: inspection.reason,
          },
        },
      );
    }
    const { worktree: _worktree, ...creationOptions } = session.creationOptions;
    const resolvedAt = new Date(this.now()).toISOString();
    const resolved: AgentSessionRecord =
      retained === undefined
        ? {
            ...session,
            workspaceResolution: {
              resolvedAt,
              action: unrecoverableReason === undefined ? "created" : "recreated",
              ...(unrecoverableReason === undefined ? {} : { unrecoverableReason }),
            },
          }
        : {
            ...session,
            creationOptions: { ...creationOptions, workspaceId: retained.workspaceId },
            workspaceResolution: { resolvedAt, action: retained.action },
          };
    await this.database.saveAgentSession(resolved);
    return resolved;
  }

  private async deliver(
    input: {
      executionId: string;
      intent: LaunchMachineIntent;
      connection: AgentConnection;
      onEvent: (event: AgentEvent) => void;
    },
    agentId: string,
    startupTimeoutMs: number,
  ): Promise<() => void> {
    const unsubscribe = await input.connection.watch(agentId, input.onEvent);
    try {
      const execution = await this.database.findAgentExecutionById(input.executionId);
      if (!execution || !isActive(execution)) throw new AgentSessionError("execution_terminal");
      if (execution.deadlineAt !== null && execution.deadlineAt.getTime() <= this.now()) {
        throw new AgentSessionError("execution_deadline_exceeded");
      }
      await input.connection.send(
        agentId,
        input.executionId,
        input.intent.continuation === undefined
          ? input.intent.prompt
          : `Hub execution: ${input.executionId}\nUse this executionId for Hub tool calls for this request.\n\n${input.intent.prompt}`,
        startupTimeoutMs,
      );
      return unsubscribe;
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  async control(
    execution: AgentExecutionRecord,
    connection: AgentConnection,
    action: "interrupt" | "archive",
  ): Promise<boolean> {
    if (!execution.agentSessionId) return true;
    const id = execution.agentSessionId;
    const session = await this.database.findAgentSession(id);
    if (!session?.agentId || !session.workspaceId) return false;
    const { agentId, workspaceId } = session;
    return this.database.withAdvisoryLock(sessionLock(session), async () => {
      const executions = await this.database.listAgentSessionExecutions(id);
      // A completed arrival cannot stop work belonging to a newer arrival.
      if (executions.some(isActive)) return true;
      // Sessions sharing the workspace keep it: only the last live one may archive it.
      if (action === "archive" && (await this.hasLiveWorkspaceSibling(session))) {
        await connection.control(agentId, workspaceId, "archive_agent");
        return true;
      }
      await connection.control(agentId, workspaceId, action);
      return true;
    });
  }

  private async hasLiveWorkspaceSibling(session: AgentSessionRecord): Promise<boolean> {
    if (session.workspaceKey === null) return false;
    const siblings = await this.database.findAgentSessionsByWorkspaceKey(
      session.projectId,
      session.workspaceKey,
    );
    for (const sibling of siblings) {
      if (sibling.id === session.id || sibling.workspaceId !== session.workspaceId) continue;
      const executions = await this.database.listAgentSessionExecutions(sibling.id);
      if (executions.some(isActive)) return true;
    }
    return false;
  }

  async releaseAuthority(
    execution: AgentExecutionRecord,
    release: (executionId: string) => Promise<void>,
  ): Promise<void> {
    const sessionId = execution.agentSessionId;
    const session =
      sessionId === null ? undefined : await this.database.findAgentSession(sessionId);
    const owners =
      sessionId === null || !session
        ? [execution.id]
        : await this.database.withAdvisoryLock(sessionLock(session), async () => {
            const executions = await this.database.listAgentSessionExecutions(sessionId);
            if (executions.some(isActive)) return [];
            return executions.map((item) => item.id);
          });
    // Revocation can call upstream services; do not keep a database lock while it runs.
    await Promise.all(owners.map(release));
  }

  async canResumeAuthority(
    execution: AgentExecutionRecord,
    available: (executionId: string) => Promise<boolean>,
  ): Promise<boolean> {
    if (execution.agentSessionId === null) return available(execution.id);
    const owners = await this.database.listAgentSessionExecutions(execution.agentSessionId);
    for (const owner of owners) {
      if (await available(owner.id)) return true;
    }
    return false;
  }
}

function workspaceOutcome(
  resolution: AgentSessionWorkspaceResolution | null,
): AgentSessionWorkspaceOutcome {
  if (resolution === null) return { action: "created" };
  return {
    action: resolution.action,
    ...(resolution.unrecoverableReason === undefined
      ? {}
      : { unrecoverableReason: resolution.unrecoverableReason }),
  };
}

function deriveSessionId(projectId: string, key: string): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(["agent-session", projectId, key]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function workspaceLockId(projectId: string, workspaceKey: string): string {
  return deriveSessionId(projectId, `workspace:${workspaceKey}`);
}
function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      ),
    )
    .digest("hex");
}

function isActive(execution: AgentExecutionRecord): boolean {
  return execution.status === "spawning" || execution.status === "running";
}
function hasTemporaryCredentials(intent: LaunchMachineIntent): boolean {
  return (
    intent.github !== undefined ||
    Object.values({ ...intent.environment.env, ...intent.env }).some(
      (value) => parseConnectionTemplate(value).length > 0,
    )
  );
}
/** The same derivation as `dispatch`: workspace-keyed sessions share the workspace lock. */
function sessionLock(session: AgentSessionRecord): string {
  if (session.workspaceKey !== null)
    return `agent-session:${workspaceLockId(session.projectId, session.workspaceKey)}`;
  return `agent-session:${session.continuationKey === null ? session.id : deriveSessionId(session.projectId, session.continuationKey)}`;
}
