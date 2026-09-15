import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { AgentSessions } from "./index.js";
import { createMemoryDatabase } from "../db/memory.js";
import { OutputExecutorRegistry, replyOutputTool } from "../execution-capabilities/outputs.js";
import { createExecutionCapabilityServer } from "../execution-capabilities/server.js";
import type {
  AgentConnection,
  AgentSnapshot,
  WorkspaceInspection,
} from "../daemons/agents/index.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import type { DaemonCreateAgentOptions } from "../daemons/protocol.js";

class TestAgents implements AgentConnection {
  readonly agents = new Map<string, AgentSnapshot>();
  readonly deliveries: { agentId: string; text: string }[] = [];
  readonly creates: DaemonCreateAgentOptions[] = [];
  readonly messages = new Set<string>();
  /** Daemon-side workspace state; a workspace unknown here is "missing". */
  readonly workspaces = new Map<string, WorkspaceInspection>();
  readonly inspections: string[] = [];
  readonly actions: string[] = [];
  archives = 0;
  restorations = 0;
  async create(_key: string, options: DaemonCreateAgentOptions) {
    this.creates.push(options);
    if (
      options.workspaceId !== undefined &&
      this.workspaces.get(options.workspaceId)?.kind !== "active"
    )
      throw new Error(`Workspace ${options.workspaceId} not found`);
    const workspaceId = options.workspaceId ?? randomUUID();
    this.workspaces.set(workspaceId, { kind: "active" });
    const agent = {
      id: randomUUID(),
      workspaceId,
      status: "idle" as const,
      pendingPermissions: [],
    };
    this.agents.set(agent.id, agent);
    return agent;
  }
  async get(id: string) {
    const agent = this.agents.get(id);
    if (!agent) throw new Error("missing");
    return agent;
  }
  async send(agentId: string, messageId: string, text: string) {
    if (this.messages.has(messageId)) return;
    this.messages.add(messageId);
    this.deliveries.push({ agentId, text });
  }
  async watch() {
    return () => {};
  }
  /** Mirrors the daemon channel: a live workspace has nothing to restore. */
  async restore(workspaceId: string) {
    const state = this.workspaces.get(workspaceId);
    if (state?.kind === "active") return false;
    if (state?.kind !== "archived") throw new Error(`Workspace ${workspaceId} cannot be restored`);
    this.restorations++;
    this.workspaces.set(workspaceId, { kind: "active" });
    for (const [id, agent] of this.agents)
      if (agent.workspaceId === workspaceId) this.agents.set(id, { ...agent, archivedAt: null });
    return true;
  }
  async inspectWorkspace(workspaceId: string) {
    this.inspections.push(workspaceId);
    return this.workspaces.get(workspaceId) ?? { kind: "missing" as const };
  }
  async readWorkspace() {
    return undefined;
  }
  async respondToPermission() {
    return "resolved" as const;
  }
  async control(
    agentId: string,
    workspaceId: string,
    action: "interrupt" | "archive" | "archive_agent",
  ) {
    this.actions.push(action);
    if (action === "archive") {
      this.archives++;
      this.workspaces.set(workspaceId, { kind: "archived" });
      for (const [id, agent] of this.agents)
        if (agent.workspaceId === workspaceId)
          this.agents.set(id, { ...agent, archivedAt: new Date().toISOString() });
    }
    if (action === "archive_agent") {
      // The agent alone is archived; its workspace stays live for the sibling sessions.
      const agent = this.agents.get(agentId);
      if (agent) this.agents.set(agentId, { ...agent, archivedAt: new Date().toISOString() });
    }
  }
}

async function fixture(now = Date.now) {
  const database = createMemoryDatabase();
  const connection = new TestAgents();
  const outputs = new OutputExecutorRegistry();
  const replies: { executionId: string; context: unknown }[] = [];
  outputs.register({
    type: "test.reply",
    tool: replyOutputTool,
    execute: async (input) => {
      replies.push({ executionId: input.agentExecutionId, context: input.outputContext });
    },
  });
  const sessions = new AgentSessions(database, "secret", "https://hub.test", outputs, now);
  const capabilities = createExecutionCapabilityServer({
    database,
    outputs,
    completionTokenSecret: "secret",
    completeExecution: async ({ executionId }) =>
      (await database.transitionAgentExecution(executionId, "succeeded")).execution,
  });
  async function arrival(
    key: string | null | false = "conversation",
    target = "daemon",
    env: Record<string, string> = {},
    prompt = "hello",
    overrides: Partial<LaunchMachineIntent> = {},
  ) {
    const executionId = randomUUID();
    const intent: LaunchMachineIntent = {
      kind: "launch_machine",
      organizationId: "org",
      projectId: "project",
      triggerRunId: randomUUID(),
      triggerName: "answer",
      environmentName: "target",
      environment: { kind: "daemon", daemonId: target, authoredSlug: target, cwd: "/repo" },
      agent: { provider: "codex" },
      prompt,
      env,
      allowOutputs: [{ type: "test.reply", max: 1 }],
      autoArchive: true,
      triggerContext: {},
      outputContext: { arrival: executionId },
      configurationRevisionId: randomUUID(),
      hubConfig: {},
      ...(key === false ? {} : { continuation: { key, compatibility: { target } } }),
      ...overrides,
    };
    await database.insertAgentExecution({
      id: executionId,
      organizationId: "org",
      projectId: "project",
      machineId: null,
      triggerContext: {},
      outputContext: intent.outputContext,
      configurationRevisionId: intent.configurationRevisionId,
      launchIntent: intent,
      ...(intent.deadlineAt === undefined ? {} : { deadlineAt: intent.deadlineAt }),
    });
    return {
      executionId,
      dispatch: (onAgentReady?: (agent: { agentId: string; workspaceId: string }) => void) =>
        sessions.dispatch({
          executionId,
          intent,
          connection,
          onEvent: () => {},
          ...(onAgentReady === undefined ? {} : { onAgentReady }),
          createOptions: async () => ({
            provider: "codex",
            cwd: "/repo",
            env: intent.github === undefined ? {} : { GH_TOKEN: "scoped-github-token" },
            toolPolicy: { preapproved: [] },
            ...(intent.environment.worktree === undefined
              ? {}
              : { worktree: intent.environment.worktree }),
          }),
        }),
    };
  }
  /** A Linear-style arrival: its own session key, a workspace key shared by the issue. */
  function issueArrival(
    sessionKey: string,
    workspaceKey = "linear:issue:issue-1",
    overrides: Partial<LaunchMachineIntent> = {},
  ) {
    return arrival(sessionKey, "daemon", {}, "work on the issue", {
      continuation: { key: sessionKey, workspaceKey, compatibility: { target: "daemon" } },
      environment: {
        kind: "daemon",
        daemonId: "daemon",
        authoredSlug: "daemon",
        cwd: "/repo",
        worktree: { mode: "branch-off", newBranch: "linear/ENG-1", base: "main" },
      },
      ...overrides,
    });
  }
  return { database, connection, sessions, replies, arrival, issueArrival, execution, call };
  async function execution(id: string) {
    const item = await database.findAgentExecutionById(id);
    if (!item) throw new Error("missing execution");
    return item;
  }
  async function call(
    executionId: string,
    name: string,
    args: Record<string, unknown>,
    ownerId = executionId,
  ) {
    const owner = await execution(ownerId);
    const session = await database.findAgentSession(owner.agentSessionId!);
    const mcp = session!.creationOptions.mcpServers!["hub"]!;
    const response = await capabilities.handleSession(
      new Request(mcp.url, {
        method: "POST",
        headers: {
          ...mcp.headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: { ...args, executionId } },
        }),
      }),
      session!.id,
    );
    const result: unknown = await response.json();
    return result;
  }
}

test("same-key arrivals share an agent; an earlier completion cannot archive newer work", async () => {
  const f = await fixture();
  const first = await f.arrival();
  const second = await f.arrival();
  const [a, b] = await Promise.all([first.dispatch(), second.dispatch()]);
  expect(a.agentId).toBe(b.agentId);
  expect(f.connection.creates).toHaveLength(1);
  expect(f.connection.deliveries).toHaveLength(2);
  await f.database.transitionAgentExecution(first.executionId, "succeeded");
  await f.sessions.control(await f.execution(first.executionId), f.connection, "archive");
  expect(f.connection.archives).toBe(0);
  await f.database.transitionAgentExecution(second.executionId, "succeeded");
  await f.sessions.control(await f.execution(second.executionId), f.connection, "archive");
  expect(f.connection.archives).toBe(1);
  const third = await f.arrival();
  expect(await third.dispatch()).toMatchObject({ agentId: a.agentId, action: "restored" });
  expect(f.connection.restorations).toBe(1);
});

test("session tools keep each arrival's destination and reject stale or foreign execution IDs", async () => {
  const f = await fixture();
  const first = await f.arrival();
  const second = await f.arrival();
  await first.dispatch();
  await second.dispatch();
  expect(await f.call(first.executionId, "reply", { content: "first" })).toMatchObject({
    result: { content: [{ type: "text", text: "Output sent" }] },
  });
  expect(await f.call(first.executionId, "finish_execution", {})).toMatchObject({
    result: { content: [{ type: "text", text: "Execution finished" }] },
  });
  expect(await f.call(first.executionId, "reply", { content: "stale" })).toMatchObject({
    result: { isError: true },
  });
  expect(await f.call(second.executionId, "reply", { content: "second" })).toMatchObject({
    result: { content: [{ type: "text", text: "Output sent" }] },
  });
  expect(f.replies).toEqual([
    { executionId: first.executionId, context: { arrival: first.executionId } },
    { executionId: second.executionId, context: { arrival: second.executionId } },
  ]);
  const foreign = await f.arrival("another");
  await foreign.dispatch();
  expect(
    await f.call(foreign.executionId, "finish_execution", {}, second.executionId),
  ).toMatchObject({ result: { isError: true } });
});

test("new-agent policy isolates arrivals and incompatible targets fail without replacement", async () => {
  const f = await fixture();
  const a = await f.arrival(null);
  const b = await f.arrival(null);
  expect((await a.dispatch()).agentId).not.toBe((await b.dispatch()).agentId);
  const first = await f.arrival();
  await first.dispatch();
  const changed = await f.arrival("conversation", "different-daemon");
  await expect(changed.dispatch()).rejects.toThrow("Continuation settings differ");
  expect(f.connection.creates).toHaveLength(3);
});

test("ordinary launches use agent sessions and preserve long prompts without enabling continuation", async () => {
  const f = await fixture();
  const prompt = "Investigate this request.\n" + "Full request context. ".repeat(1_000);
  const first = await f.arrival(false, "daemon", {}, prompt);
  const second = await f.arrival(false, "daemon", {}, prompt);
  const a = await first.dispatch();
  const replay = await first.dispatch();
  const b = await second.dispatch();
  expect(replay.agentId).toBe(a.agentId);
  expect(b.agentId).not.toBe(a.agentId);
  expect(f.connection.creates).toHaveLength(2);
  expect(f.connection.deliveries).toEqual([
    { agentId: a.agentId, text: prompt },
    { agentId: b.agentId, text: prompt },
  ]);
});

test("steering keeps the active agent's scoped credentials instead of requiring a new agent", async () => {
  const f = await fixture();
  const env = { TOKEN: "${{ paseo.connections.support.token }}" };
  const github = {
    connection: "getpaseo-github",
    repositories: ["getpaseo/paseo"],
    permissions: { contents: "write" as const },
    durationMs: 60 * 60 * 1000,
  };
  const first = await f.arrival("conversation", "daemon", env, "first request", { github });
  const original = await first.dispatch();
  const next = await f.arrival("conversation", "daemon", env, "follow-up", { github });
  expect(await next.dispatch()).toMatchObject({ agentId: original.agentId, action: "continued" });
  expect(f.connection.creates).toHaveLength(1);
  expect(f.connection.creates[0]?.env).toEqual({ GH_TOKEN: "scoped-github-token" });
  expect(f.connection.deliveries).toHaveLength(2);
});

test("steering cannot extend the active agent's original max-runtime deadline", async () => {
  const f = await fixture();
  const deadlineAt = new Date("2030-01-01T01:00:00Z");
  const first = await f.arrival("conversation", "daemon", {}, "first request", { deadlineAt });
  await first.dispatch();
  const next = await f.arrival("conversation", "daemon", {}, "follow-up", {
    deadlineAt: new Date("2030-01-01T01:30:00Z"),
  });
  await next.dispatch();
  expect((await f.execution(first.executionId)).deadlineAt).toEqual(deadlineAt);
  expect((await f.execution(next.executionId)).deadlineAt).toEqual(deadlineAt);
});

test("a completed credentialed task gets a fresh agent and isolates the previous agent's tools", async () => {
  const f = await fixture();
  const github = {
    connection: "getpaseo-github",
    repositories: ["getpaseo/paseo"],
    permissions: { contents: "write" as const },
    durationMs: 60 * 60 * 1000,
  };
  const first = await f.arrival("conversation", "daemon", {}, "first", { github });
  const original = await first.dispatch();
  await f.database.transitionAgentExecution(first.executionId, "succeeded");
  await f.sessions.releaseAuthority(await f.execution(first.executionId), async () => {});
  const next = await f.arrival("conversation", "daemon", {}, "next task", { github });
  const fresh = await next.dispatch();
  expect(fresh.agentId).not.toBe(original.agentId);
  expect(f.connection.creates).toHaveLength(2);
  expect(await f.call(next.executionId, "finish_execution", {}, first.executionId)).toMatchObject({
    result: { isError: true },
  });
});

test("a ping cannot send more work after the inherited deadline while timeout cleanup is pending", async () => {
  let now = Date.parse("2030-01-01T00:00:00Z");
  const f = await fixture(() => now);
  const first = await f.arrival("conversation", "daemon", {}, "first", {
    deadlineAt: new Date(now + 1000),
  });
  await first.dispatch();
  now += 1000;
  const next = await f.arrival("conversation", "daemon", {}, "too late", {
    deadlineAt: new Date(now + 1000),
  });
  await expect(next.dispatch()).rejects.toThrow("execution_deadline_exceeded");
  expect(f.connection.deliveries).toHaveLength(1);
});

test("sessions sharing a workspace key create later agents inside the first agent's workspace", async () => {
  const f = await fixture();
  const first = await f.issueArrival("linear:session:1");
  const opened = await first.dispatch();
  expect(opened).toMatchObject({ action: "created", workspace: { action: "created" } });
  expect(f.connection.creates[0]).toMatchObject({
    worktree: { mode: "branch-off", newBranch: "linear/ENG-1", base: "main" },
    labels: {
      "hub.workspace-key": "linear:issue:issue-1",
      "hub.continuation-key": "linear:session:1",
    },
  });
  expect(f.connection.creates[0]).not.toHaveProperty("workspaceId");

  const second = await f.issueArrival("linear:session:2");
  const joined = await second.dispatch();
  expect(joined.agentId).not.toBe(opened.agentId);
  expect(joined.workspaceId).toBe(opened.workspaceId);
  expect(joined).toMatchObject({ action: "created", workspace: { action: "reused" } });
  expect(f.connection.creates[1]).toMatchObject({
    workspaceId: opened.workspaceId,
    labels: {
      "hub.workspace-key": "linear:issue:issue-1",
      "hub.continuation-key": "linear:session:2",
    },
  });
  expect(f.connection.creates[1]).not.toHaveProperty("worktree");
  expect(f.connection.inspections).toEqual([opened.workspaceId]);
  const conversation = await f.arrival("conversation");
  await conversation.dispatch();
  expect(f.connection.creates[2]).toMatchObject({
    labels: { "hub.continuation-key": "conversation" },
  });
  expect(f.connection.creates[2]).not.toHaveProperty("labels.hub.workspace-key");
  const plain = await f.arrival(false);
  await plain.dispatch();
  expect(f.connection.creates[3]).not.toHaveProperty("labels");
});

test("an archived issue workspace is restored before the next agent is created in it", async () => {
  const f = await fixture();
  const first = await f.issueArrival("linear:session:1");
  const opened = await first.dispatch();
  await f.database.transitionAgentExecution(first.executionId, "succeeded");
  await f.sessions.control(await f.execution(first.executionId), f.connection, "archive");
  expect(f.connection.archives).toBe(1);

  const second = await f.issueArrival("linear:session:2");
  const restored = await second.dispatch();
  expect(restored).toMatchObject({
    workspaceId: opened.workspaceId,
    action: "created",
    workspace: { action: "restored" },
  });
  expect(f.connection.restorations).toBe(1);
  expect(f.connection.creates[1]).toMatchObject({ workspaceId: opened.workspaceId });
});

test("a missing issue workspace is replaced by a fresh worktree", async () => {
  const f = await fixture();
  const first = await f.issueArrival("linear:session:1");
  const opened = await first.dispatch();
  f.connection.workspaces.delete(opened.workspaceId);

  const second = await f.issueArrival("linear:session:2");
  const recreated = await second.dispatch();
  expect(recreated.workspaceId).not.toBe(opened.workspaceId);
  expect(recreated).toMatchObject({ action: "created", workspace: { action: "created" } });
  expect(f.connection.creates[1]).toMatchObject({ worktree: { mode: "branch-off" } });
  expect(f.connection.creates[1]).not.toHaveProperty("workspaceId");
});

test("an unrecoverable issue workspace is recreated and the daemon's reason surfaces", async () => {
  const f = await fixture();
  const first = await f.issueArrival("linear:session:1");
  const opened = await first.dispatch();
  f.connection.workspaces.set(opened.workspaceId, {
    kind: "unrecoverable",
    reason: "worktree_branch_missing",
  });

  const second = await f.issueArrival("linear:session:2");
  const recreated = await second.dispatch();
  expect(recreated.workspaceId).not.toBe(opened.workspaceId);
  expect(recreated.workspace).toEqual({
    action: "recreated",
    unrecoverableReason: "worktree_branch_missing",
  });
  expect(f.connection.restorations).toBe(0);
  expect(f.connection.creates[1]).toMatchObject({ worktree: { mode: "branch-off" } });
});

test("a completed credentialed issue session gets a fresh agent in the same workspace", async () => {
  const f = await fixture();
  const github = {
    connection: "getpaseo-github",
    repositories: ["getpaseo/paseo"],
    permissions: { contents: "write" as const },
    durationMs: 60 * 60 * 1000,
  };
  const first = await f.issueArrival("linear:session:1", "linear:issue:issue-1", { github });
  const original = await first.dispatch();
  await f.database.transitionAgentExecution(first.executionId, "succeeded");
  await f.sessions.releaseAuthority(await f.execution(first.executionId), async () => {});

  const followUp = await f.issueArrival("linear:session:1", "linear:issue:issue-1", { github });
  const fresh = await followUp.dispatch();
  expect(fresh.agentId).not.toBe(original.agentId);
  expect(fresh.workspaceId).toBe(original.workspaceId);
  expect(fresh).toMatchObject({ action: "created", workspace: { action: "reused" } });
  expect(f.connection.creates).toHaveLength(2);
  expect(f.connection.creates[1]).toMatchObject({ workspaceId: original.workspaceId });
});

test("the workspace choice is persisted before creation so a replayed dispatch repeats the same request", async () => {
  const f = await fixture();
  const first = await f.issueArrival("linear:session:1");
  await first.dispatch();
  const save = f.database.saveAgentSession.bind(f.database);
  let lost = false;
  vi.spyOn(f.database, "saveAgentSession").mockImplementation(async (session) => {
    if (!lost && session.agentId !== null && session.continuationKey === "linear:session:2") {
      lost = true;
      throw new Error("connection reset after the daemon created the agent");
    }
    await save(session);
  });

  const second = await f.issueArrival("linear:session:2");
  await expect(second.dispatch()).rejects.toThrow("connection reset");
  expect(f.connection.creates).toHaveLength(2);
  const inspections = f.connection.inspections.length;

  const replayed = await second.dispatch();
  expect(f.connection.creates).toHaveLength(3);
  expect(f.connection.creates[2]).toEqual(f.connection.creates[1]);
  expect(f.connection.inspections).toHaveLength(inspections);
  expect(replayed).toMatchObject({ action: "created", workspace: { action: "reused" } });
  const session = await f.database.findAgentSession(
    (await f.execution(second.executionId)).agentSessionId!,
  );
  expect(session?.workspaceResolution).toMatchObject({ action: "reused" });
});

test("every session of a workspace key serializes on the workspace lock, in dispatch and control alike", async () => {
  const f = await fixture();
  const locks: string[] = [];
  const withLock = f.database.withAdvisoryLock.bind(f.database);
  vi.spyOn(f.database, "withAdvisoryLock").mockImplementation((key, fn) => {
    locks.push(key);
    return withLock(key, fn);
  });
  const first = await f.issueArrival("linear:session:1");
  await first.dispatch();
  const second = await f.issueArrival("linear:session:2");
  await second.dispatch();
  const other = await f.issueArrival("linear:session:3", "linear:issue:issue-2");
  await other.dispatch();
  await f.database.transitionAgentExecution(first.executionId, "succeeded");
  await f.sessions.control(await f.execution(first.executionId), f.connection, "archive");
  await f.sessions.releaseAuthority(await f.execution(first.executionId), async () => {});

  const [dispatchOne, dispatchTwo, dispatchOther, control, release] = locks;
  expect(dispatchOne).toBe(dispatchTwo);
  expect(dispatchOther).not.toBe(dispatchOne);
  expect(control).toBe(dispatchOne);
  expect(release).toBe(dispatchOne);
  expect(locks).toHaveLength(5);
});

test("the agent is announced before its prompt is delivered", async () => {
  const f = await fixture();
  const first = await f.arrival();
  const seen: { agentId: string; workspaceId: string; deliveries: number }[] = [];
  const dispatched = await first.dispatch((agent) => {
    seen.push({ ...agent, deliveries: f.connection.deliveries.length });
  });
  expect(seen).toEqual([
    { agentId: dispatched.agentId, workspaceId: dispatched.workspaceId, deliveries: 0 },
  ]);
  expect(f.connection.deliveries).toHaveLength(1);
});

test("a session whose agent alone was archived reuses its live workspace without restoring it", async () => {
  const f = await fixture();
  const first = await f.issueArrival("linear:session:1");
  const opened = await first.dispatch();
  const second = await f.issueArrival("linear:session:2");
  await second.dispatch();
  await f.database.transitionAgentExecution(first.executionId, "succeeded");
  await f.sessions.control(await f.execution(first.executionId), f.connection, "archive");
  expect(f.connection.actions).toEqual(["archive_agent"]);
  expect((await f.connection.get(opened.agentId)).archivedAt).toEqual(expect.any(String));

  const again = await f.issueArrival("linear:session:1");
  const resumed = await again.dispatch();
  expect(resumed).toMatchObject({
    agentId: opened.agentId,
    workspaceId: opened.workspaceId,
    action: "restored",
    workspace: { action: "reused" },
  });
  expect(f.connection.creates).toHaveLength(2);
  expect(f.connection.restorations).toBe(0);
});

test("archiving a finished issue session keeps the workspace while a sibling session still works", async () => {
  const f = await fixture();
  const first = await f.issueArrival("linear:session:1");
  await first.dispatch();
  const second = await f.issueArrival("linear:session:2");
  await second.dispatch();
  await f.database.transitionAgentExecution(first.executionId, "succeeded");
  await f.sessions.control(await f.execution(first.executionId), f.connection, "archive");
  expect(f.connection.actions).toEqual(["archive_agent"]);
  expect(f.connection.archives).toBe(0);

  await f.database.transitionAgentExecution(second.executionId, "succeeded");
  await f.sessions.control(await f.execution(second.executionId), f.connection, "archive");
  expect(f.connection.actions).toEqual(["archive_agent", "archive"]);
  expect(f.connection.archives).toBe(1);
});
