import { z } from "zod";
import { describe, expect, test, vi } from "vitest";
import { DaemonAgentError, DaemonAgents, PERMISSION_CONFIRM_MS } from "./index.js";
import { DaemonResponseLostError, type DaemonCreateAgentOptions } from "../protocol.js";

const prompt = "Full request context. ".repeat(1_000) + "End.";
const options: DaemonCreateAgentOptions = {
  provider: "codex",
  cwd: "/workspace",
  env: { REQUEST_ENV: "configured" },
  providerOptions: { sandbox_mode: "workspace-write" },
  toolPolicy: { preapproved: [{ kind: "mcp", server: "hub", tool: "finish_execution" }] },
};

test("ordinary creation keeps prompt delivery separate from optional titles and preserves provider configuration", async () => {
  const requests: Record<string, unknown>[] = [];
  const agents = new DaemonAgents((frame) => {
    const { message } = z
      .object({ message: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(frame));
    requests.push(message);
    agents.receive({
      type: "session",
      message: {
        type: message["type"] === "create_agent_request" ? "status" : "send_agent_message_response",
        payload: {
          requestId: message["requestId"],
          status: "agent_created",
          accepted: true,
          agent: { id: "agent", workspaceId: "workspace", status: "idle" },
        },
      },
    });
  });
  enable(agents);
  const created = await agents.create("stable-creation-key", options);
  await agents.send(created.id, "stable-message-key", prompt);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({
    type: "create_agent_request",
    idempotencyKey: "stable-creation-key",
    config: {
      provider: options.provider,
      cwd: options.cwd,
      providerOptions: options.providerOptions,
      toolPolicy: options.toolPolicy,
    },
    env: options.env,
  });
  expect(requests[0]).not.toHaveProperty("initialPrompt");
  expect(requests[0]).not.toHaveProperty("config.title");
  expect(requests[1]).toMatchObject({
    type: "send_agent_message_request",
    agentId: created.id,
    messageId: "stable-message-key",
    text: prompt,
  });
});

test("requires ordinary agent RPCs and durable receipts instead of falling back to Hub creation", async () => {
  const frames: string[] = [];
  const agents = new DaemonAgents((frame) => frames.push(frame));
  await expect(agents.create("key", options)).rejects.toThrow("Update the Paseo daemon");
  expect(frames).toEqual([]);
});

test("a lost response remains recoverable instead of reporting a rejected creation", async () => {
  const agents = new DaemonAgents(() => {});
  enable(agents);
  const creation = agents.create("key", options);
  agents.close();
  await expect(creation).rejects.toBeInstanceOf(DaemonResponseLostError);
});

function enable(agents: DaemonAgents): void {
  agents.receive({
    type: "session",
    message: {
      type: "server_info",
      payload: { features: { hubAgentRpc: true, agentRequestReceipts: true } },
    },
  });
}

test.each(["create", "restore", "send"] as const)(
  "%s honors the supplied startup wait without changing the RPC",
  async (operation) => {
    vi.useFakeTimers();
    let respond: (() => void) | undefined;
    const agents = new DaemonAgents((frame) => {
      const { message } = z
        .object({ message: z.record(z.string(), z.unknown()) })
        .parse(JSON.parse(frame));
      const reply = () =>
        agents.receive({
          type: "session",
          message: {
            type: "response",
            payload: {
              requestId: message["requestId"],
              state: { kind: "recoverable" },
              accepted: true,
              agent: { id: "agent", workspaceId: "workspace", status: "idle" },
            },
          },
        });
      if (message["type"] === "workspace.recovery.inspect.request") reply();
      else respond = reply;
      expect(message).not.toHaveProperty("timeoutMs");
    });
    try {
      enable(agents);
      const start = () => {
        if (operation === "create") return agents.create("key", options, 180_000);
        if (operation === "restore") return agents.restore("workspace", 180_000);
        return agents.send("agent", "message-key", "hello", 180_000);
      };
      const outcome = start().then(
        () => "accepted",
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(150_000);
      expect(respond).toBeDefined();
      respond!();
      expect(await outcome).toBe("accepted");

      const expired = start().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(await expired).toBeInstanceOf(DaemonResponseLostError);
    } finally {
      agents.close();
      vi.useRealTimers();
    }
  },
);

/** A daemon double replying to each request through `reply(message)`; unanswered requests hang. */
function channel(reply: (message: Record<string, unknown>) => Record<string, unknown> | undefined) {
  const requests: Record<string, unknown>[] = [];
  const agents = new DaemonAgents((frame) => {
    const { message } = z
      .object({ message: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(frame));
    requests.push(message);
    const payload = reply(message);
    if (payload === undefined) return;
    agents.receive({
      type: "session",
      message: { type: "response", payload: { requestId: message["requestId"], ...payload } },
    });
  });
  enable(agents);
  return { agents, requests };
}

const createdAgent = { id: "agent", workspaceId: "workspace", status: "idle" };

test("creation places an existing workspace and labels on the wire only when given", async () => {
  const { agents, requests } = channel((message) =>
    message["type"] === "create_agent_request"
      ? { status: "agent_created", accepted: true, agent: createdAgent }
      : undefined,
  );
  const plain = await agents.create("plain-key", options);
  expect(plain.pendingPermissions).toEqual([]);
  expect(requests[0]).not.toHaveProperty("workspaceId");
  expect(requests[0]).not.toHaveProperty("labels");

  await agents.create("shared-key", {
    ...options,
    workspaceId: "workspace",
    labels: { "hub.workspace-key": "linear:issue:1", "hub.continuation-key": "linear:session:1" },
  });
  expect(requests[1]).toMatchObject({
    type: "create_agent_request",
    idempotencyKey: "shared-key",
    workspaceId: "workspace",
    labels: { "hub.workspace-key": "linear:issue:1", "hub.continuation-key": "linear:session:1" },
  });
  expect(requests[1]).not.toHaveProperty("config.workspaceId");
  expect(requests[1]).not.toHaveProperty("config.labels");
});

test("snapshots carry the daemon's pending permissions", async () => {
  const { agents } = channel(() => ({
    agent: { ...createdAgent, pendingPermissions: [{ id: "perm-1", name: "shell", kind: "tool" }] },
  }));
  const agent = await agents.get("agent");
  expect(agent.pendingPermissions).toEqual([{ id: "perm-1", name: "shell", kind: "tool" }]);
});

test.each([
  [{ kind: "recoverable" }, { kind: "archived" }],
  [{ kind: "unavailable", reason: "workspace_not_archived" }, { kind: "active" }],
  [{ kind: "unavailable", reason: "workspace_not_found" }, { kind: "missing" }],
  [
    { kind: "unavailable", reason: "worktree_branch_missing" },
    { kind: "unrecoverable", reason: "worktree_branch_missing" },
  ],
  [
    { kind: "unavailable", reason: "project_directory_missing" },
    { kind: "unrecoverable", reason: "project_directory_missing" },
  ],
] as const)("inspectWorkspace maps the recovery state %j to %j", async (state, inspection) => {
  const { agents, requests } = channel(() => ({ state }));
  expect(await agents.inspectWorkspace("workspace")).toEqual(inspection);
  expect(requests).toEqual([
    expect.objectContaining({
      type: "workspace.recovery.inspect.request",
      workspaceId: "workspace",
    }),
  ]);
});

test("readWorkspace pages through the daemon's workspaces until the requested one appears", async () => {
  const pages = [
    { entries: [{ id: "other", githubRuntime: null }], pageInfo: { nextCursor: "page-2" } },
    {
      entries: [
        {
          id: "workspace",
          githubRuntime: {
            pullRequest: { url: "https://github.com/acme/repo/pull/7", number: 7, title: "Fix" },
          },
        },
      ],
      pageInfo: { nextCursor: null },
    },
  ];
  const { agents, requests } = channel(() => pages.shift());
  const workspace = await agents.readWorkspace("workspace");
  expect(workspace?.githubRuntime?.pullRequest).toMatchObject({
    url: "https://github.com/acme/repo/pull/7",
    number: 7,
    title: "Fix",
  });
  expect(requests).toEqual([
    expect.objectContaining({
      type: "fetch_workspaces_request",
      page: { limit: 200 },
      sort: [{ key: "activity_at", direction: "desc" }],
    }),
    expect.objectContaining({
      type: "fetch_workspaces_request",
      page: { limit: 200, cursor: "page-2" },
    }),
  ]);
  expect(requests[0]).not.toHaveProperty("page.cursor");
});

test("readWorkspace reports an unknown workspace after the last page", async () => {
  const { agents, requests } = channel(() => ({
    entries: [{ id: "other" }],
    pageInfo: { nextCursor: null },
  }));
  expect(await agents.readWorkspace("workspace")).toBeUndefined();
  expect(requests).toHaveLength(1);
});

test("archive_agent archives the agent alone and leaves the workspace request untouched", async () => {
  const { agents, requests } = channel(() => ({}));
  await agents.control("agent", "workspace", "archive_agent");
  await agents.control("agent", "workspace", "archive");
  await agents.control("agent", "workspace", "interrupt");
  expect(requests).toEqual([
    expect.objectContaining({ type: "archive_agent_request", agentId: "agent" }),
    expect.objectContaining({ type: "archive_workspace_request", workspaceId: "workspace" }),
    expect.objectContaining({ type: "cancel_agent_request", agentId: "agent" }),
  ]);
  expect(requests[0]).not.toHaveProperty("workspaceId");
});

describe("respondToPermission", () => {
  const response = { behavior: "allow" as const, selectedActionId: "allow-once" };

  test("sends the daemon's own request id and resolves on agent_permission_resolved", async () => {
    const { agents, requests } = channel(() => undefined);
    const outcome = agents.respondToPermission("agent", "perm-1", response);
    expect(requests).toEqual([
      { type: "agent_permission_response", agentId: "agent", requestId: "perm-1", response },
    ]);
    agents.receive({
      type: "session",
      message: {
        type: "agent_permission_resolved",
        payload: { agentId: "agent", requestId: "perm-1", resolution: response },
      },
    });
    expect(await outcome).toBe("resolved");
  });

  test("resolves on the streamed permission_resolved of the same request", async () => {
    const { agents } = channel(() => undefined);
    const outcome = agents.respondToPermission("agent", "perm-1", response);
    agents.receive({
      type: "session",
      message: {
        type: "agent_stream",
        payload: {
          agentId: "agent",
          timestamp: "2026-01-01T00:00:00.000Z",
          event: {
            type: "permission_resolved",
            provider: "codex",
            requestId: "perm-other",
            resolution: response,
          },
        },
      },
    });
    agents.receive({
      type: "session",
      message: {
        type: "agent_stream",
        payload: {
          agentId: "agent",
          timestamp: "2026-01-01T00:00:00.000Z",
          event: {
            type: "permission_resolved",
            provider: "codex",
            requestId: "perm-1",
            resolution: response,
          },
        },
      },
    });
    expect(await outcome).toBe("resolved");
    agents.close();
  });

  test("surfaces the daemon's refusal with its code", async () => {
    const { agents } = channel((message) => {
      agents.receive({
        type: "session",
        message: {
          type: "rpc_error",
          payload: {
            requestId: message["requestId"],
            requestType: message["type"],
            error: "Session is not authorized for agent_permission_response",
            code: "access_denied",
          },
        },
      });
      return undefined;
    });
    const failure = await agents
      .respondToPermission("agent", "perm-1", response)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DaemonAgentError);
    expect(failure).toMatchObject({
      code: "access_denied",
      message: "Session is not authorized for agent_permission_response",
    });
  });

  test("reports unconfirmed when nothing confirms the answer in time", async () => {
    vi.useFakeTimers();
    try {
      const { agents } = channel(() => undefined);
      const outcome = agents.respondToPermission("agent", "perm-1", response);
      await vi.advanceTimersByTimeAsync(PERMISSION_CONFIRM_MS);
      expect(await outcome).toBe("unconfirmed");
    } finally {
      vi.useRealTimers();
    }
  });
});
