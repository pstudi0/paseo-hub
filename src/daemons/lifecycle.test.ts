import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import { DaemonResponseLostError } from "./protocol.js";
import { DaemonAgentError, type AgentConnection, type AgentEvent } from "./agents/index.js";
import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import type { DaemonEvent, DaemonConnection } from "./protocol.js";
import {
  createDaemonDispatchLifecycle,
  DaemonDispatchFailure,
  type DaemonDispatchLifecycle,
} from "./lifecycle.js";
import { createDurableWorkflowHandler } from "../workflows/engine.js";
import type {
  AgentDispatchNotification,
  AgentStreamNotification,
  TriggerProvider,
} from "../triggers/index.js";
import { createUnlimitedEntitlementsService } from "../entitlements/test-utils.js";
import type { DaemonRecord } from "../db/types.js";
import { createLogger, serializeError } from "../logger.js";
import { assertOneFailure, FailureLogStream } from "../test-utils/failure-logs.js";

const DAEMON_ID = "daemon-ack-test";
const AGENT_ID = "agent-ack-test";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
const ACKNOWLEDGED_AT = new Date("2026-01-01T00:00:01.000Z");

describe("durable Hub action acknowledgement state", () => {
  it("keeps the classified dispatch code in redacted error logs", () => {
    const diagnostic = serializeError(
      new DaemonDispatchFailure("github_authority_unavailable", {
        cause: Object.assign(new Error("credential detail must not be logged"), {
          code: "github_authority_unavailable",
        }),
      }),
    );

    assert.equal(diagnostic["code"], "github_authority_unavailable");
    const cause = diagnostic["cause"];
    assert.ok(typeof cause === "object" && cause !== null);
    assert.equal(Reflect.get(cause, "code"), "github_authority_unavailable");
    assert.equal(JSON.stringify(diagnostic).includes("credential detail"), false);
  });

  it.each(["spawning", "running"] as const)(
    "recovers %s delivery and observation when reconnects overlap after creation",
    async (status) => {
      const database = createMemoryDatabase();
      const daemon = daemonRecord();
      const intent: LaunchMachineIntent = {
        kind: "launch_machine",
        organizationId: "org-reconnect",
        projectId: "project-reconnect",
        triggerRunId: "run-reconnect",
        triggerName: "reconnect",
        environmentName: "runner",
        environment: {
          kind: "daemon",
          daemonId: daemon.id,
          authoredSlug: daemon.slug,
          cwd: "/repo",
        },
        agent: { provider: "codex" },
        prompt: "Full prompt ".repeat(100),
        allowOutputs: [],
        autoArchive: false,
        triggerContext: {},
        outputContext: {},
        configurationRevisionId: "revision-reconnect",
        hubConfig: {},
      };
      await database.insertAgentExecution({
        id: EXECUTION_ID,
        organizationId: intent.organizationId,
        projectId: intent.projectId,
        machineId: null,
        daemonId: daemon.id,
        triggerContext: {},
        outputContext: {},
        configurationRevisionId: intent.configurationRevisionId,
        launchIntent: intent,
      });
      if (status === "running") await database.transitionAgentExecution(EXECUTION_ID, "running");
      let started!: () => void;
      const sending = new Promise<void>((resolve) => {
        started = resolve;
      });
      let loseResponse!: (error: Error) => void;
      const response = new Promise<void>((_resolve, reject) => {
        loseResponse = reject;
      });
      const deliveries = new Map<string, string>();
      let creates = 0;
      let currentSends = 0;
      let subscriptions = 0;
      const agent = {
        id: AGENT_ID,
        workspaceId: "workspace-reconnect",
        status: "idle" as const,
        pendingPermissions: [],
      };
      const agents: AgentConnection = {
        create: async () => {
          creates++;
          return agent;
        },
        get: async () => agent,
        restore: async () => true,
        control: async () => {},
        inspectWorkspace: async () => ({ kind: "active" }),
        readWorkspace: async () => undefined,
        respondToPermission: async () => "resolved",
        watch: async () => {
          subscriptions++;
          return () => {
            subscriptions--;
          };
        },
        send: async (_agentId, messageId, text) => {
          deliveries.set(messageId, text);
          started();
          await response;
        },
      };
      let connection: DaemonConnection = {
        agents,
        getProviderSnapshot: async () => {
          throw new Error("Provider catalog is not used");
        },
        refreshProviderSnapshot: async () => {},
      };
      const lifecycle = createDaemonDispatchLifecycle({
        database,
        connectionForDaemon: () => connection,
        publicBaseUrl: "https://hub.test",
        completionTokenSecret: "test-secret",
      });
      try {
        const original = lifecycle.recoverDaemon(daemon);
        await sending;
        connection = {
          ...connection,
          agents: {
            ...agents,
            send: async (_agentId, messageId, text) => {
              currentSends++;
              assert.equal(deliveries.get(messageId), text);
              deliveries.set(messageId, text);
            },
          },
        };
        const replacement = lifecycle.recoverDaemon(daemon);
        loseResponse(new DaemonResponseLostError());
        await Promise.all([original, replacement]);
        assert.equal(currentSends, 1);
        assert.equal(creates, 1);
        assert.deepEqual([...deliveries], [[EXECUTION_ID, intent.prompt]]);
        assert.equal((await database.findAgentExecutionById(EXECUTION_ID))?.status, "running");
        assert.equal(lifecycle.activeExecutionObservationCount(), 1);
        assert.equal(subscriptions, 1);
      } finally {
        await lifecycle.stop();
      }
      assert.equal(subscriptions, 0);
    },
  );

  it("logs a daemon execution recovery failure exactly once", async () => {
    const canary = "daemon-lifecycle-secret-4c09";
    const database = createMemoryDatabase();
    const daemon = daemonRecord();
    const executionId = "00000000-0000-4000-8000-0000000000f1";
    await database.insertAgentExecution({
      id: executionId,
      organizationId: "organization-lifecycle-log",
      projectId: "project-lifecycle-log",
      machineId: null,
      daemonId: daemon.id,
      triggerContext: {},
      outputContext: {},
      configurationRevisionId: "revision-lifecycle-log",
    });
    vi.spyOn(database, "findAgentExecutionById").mockRejectedValueOnce(new Error(canary));
    const stream = new FailureLogStream();
    const lifecycle = createDaemonDispatchLifecycle({
      database,
      connectionForDaemon: () => new AcknowledgementConnection(),
      publicBaseUrl: "http://hub.test",
      test: { logger: createLogger(stream) },
    });

    await lifecycle.recoverDaemon(daemon);

    assertOneFailure(stream, {
      operation: "daemon.execution.recover",
      component: "daemons",
      canary,
    });
    await lifecycle.stop();
  });

  it("owns a rejected daemon event without leaking it to the process", async () => {
    const fixture = await acknowledgementFixture();
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);
    vi.spyOn(fixture.database, "recordAgentExecutionHubAcknowledgement").mockRejectedValueOnce(
      new Error("database event write failed"),
    );

    try {
      await fixture.connection.emitObserved(turnCompleted());
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      await fixture.lifecycle.stop();
    }
  });

  it("defers workflow-owned terminal provider failure notification to the outbox", async () => {
    const database = createMemoryDatabase();
    let failureHooks = 0;
    const provider: TriggerProvider = {
      name: "test",
      eventNames: ["manual.test"],
      match: () => Promise.resolve([]),
      onAgentExecutionFailed: async () => {
        failureHooks += 1;
      },
    };
    const lifecycle = createDaemonDispatchLifecycle({
      database,
      connectionForDaemon: () => undefined,
      providers: [provider],
    });
    const run = (
      await database.createAcceptedTriggerRun({
        organizationId: "org-workflow-terminal",
        projectId: "project-workflow-terminal",
        configurationRevisionId: "revision-workflow-terminal",
        providerEventReceiptId: "receipt-workflow-terminal",
        configuredTriggerName: "terminal",
        prompt: "raw",
        inputs: {},
        triggerContext: { provider: "test" },
        outputContext: { provider: "test" },
        deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
        stepIds: ["step"],
      })
    ).run;
    const step = (await database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    const execution = await database.insertAgentExecution({
      id: "00000000-0000-4000-8000-0000000000dd",
      organizationId: run.organizationId,
      projectId: run.projectId,
      machineId: null,
      daemonId: DAEMON_ID,
      triggerContext: run.triggerContext,
      outputContext: run.outputContext,
      configurationRevisionId: run.configurationRevisionId,
      workflowStepRunId: step.id,
      deadlineAt: new Date("2000-01-01T00:00:00.000Z"),
      idleDeadlineAt: new Date("2000-01-01T00:00:00.000Z"),
    });
    await database.linkWorkflowStepRunExecution(step.id, execution.id);

    await lifecycle.recoverAgentExecutionDeadlines();

    assert.equal(failureHooks, 0);
    const pendingDelivery = await database.findTriggerRunById(run.id);
    assert.equal(pendingDelivery?.status, "failed");
    assert.equal(pendingDelivery?.outcome, "accepted");
    assert.equal(
      pendingDelivery?.outcome === "accepted"
        ? pendingDelivery.terminalNotificationDeliveredAt
        : null,
      null,
    );

    const engine = createDurableWorkflowHandler({
      database,
      entitlements: createUnlimitedEntitlementsService(),
      providers: [],
      onWorkflowRunTerminal: (terminalRun) => lifecycle.notifyWorkflowRunTerminal(terminalRun),
    }).engine;
    await engine.processAvailable();

    const delivered = await database.findTriggerRunById(run.id);
    assert.equal(failureHooks, 1);
    assert.equal(
      delivered?.outcome === "accepted"
        ? delivered.terminalNotificationDeliveredAt !== null
        : false,
      true,
    );
    await lifecycle.stop();
  });

  it("ignores unrelated failed or canceled tools when finish_execution completes", async () => {
    const fixture = await acknowledgementFixture();
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);

    await fixture.connection.emit(toolCall("shell-call", "shell", "failed"));
    await fixture.connection.emit(toolCall("other-call", "other", "canceled"));
    await fixture.connection.emit(
      toolCall("finish-call", "mcp__hub__finish_execution", "completed"),
    );
    await fixture.connection.emit(
      toolCall("finish-call-retry", "hub.finish_execution", "canceled"),
    );
    await fixture.connection.emit(turnCompleted());
    await fixture.connection.emit(agentIdle());

    const execution = await fixture.database.findAgentExecutionById(EXECUTION_ID);
    assert.equal(execution?.hubActionAcknowledgements.finishExecutionCall?.callId, "finish-call");
    assert.equal(execution?.hubActionAcknowledgements.finishExecutionCall?.status, "completed");
    assert.deepEqual(fixture.connection.actions, ["archive"]);
    assert.notEqual(execution?.hubActionReadyAt, null);
    assert.notEqual(execution?.hubActionCompletedAt, null);
    await fixture.lifecycle.stop();
  });

  it.each(["running", "canceled"] as const)(
    "does not archive while finish_execution is %s",
    async (status) => {
      const fixture = await acknowledgementFixture();
      await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);

      await fixture.connection.emit(toolCall("finish-call", "hub.finish_execution", status));
      await fixture.connection.emit(turnCompleted());
      await fixture.connection.emit(agentIdle());

      const execution = await fixture.database.findAgentExecutionById(EXECUTION_ID);
      assert.deepEqual(fixture.connection.actions, []);
      assert.equal(execution?.hubActionReadyAt, null);
      assert.equal(execution?.hubActionCompletedAt, null);
      await fixture.lifecycle.stop();
    },
  );

  it("resumes durable partial signals across restart and archives exactly once", async () => {
    const fixture = await acknowledgementFixture();
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);
    await fixture.connection.emit(toolCall("finish-call", "hub.finish_execution", "completed"));
    await fixture.lifecycle.stop();

    fixture.lifecycle = createLifecycle(fixture.database, fixture.connection);
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);
    assert.equal(
      (await fixture.database.findAgentExecutionById(EXECUTION_ID))?.hubActionReadyAt,
      null,
    );
    await fixture.connection.emit(turnCompleted());
    await fixture.lifecycle.stop();

    fixture.lifecycle = createLifecycle(fixture.database, fixture.connection);
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);
    assert.notEqual(
      (await fixture.database.findAgentExecutionById(EXECUTION_ID))?.hubActionAcknowledgements
        .terminalAt,
      null,
    );
    await fixture.connection.emit(agentIdle());

    fixture.lifecycle = createLifecycle(fixture.database, fixture.connection);
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);
    const execution = await fixture.database.findAgentExecutionById(EXECUTION_ID);
    assert.deepEqual(fixture.connection.actions, ["archive"]);
    assert.notEqual(execution?.hubActionReadyAt, null);
    assert.notEqual(execution?.hubActionCompletedAt, null);
    await fixture.lifecycle.stop();
  });
});

async function acknowledgementFixture() {
  const database = createMemoryDatabase({ now: () => new Date("2026-01-01T00:00:00.000Z") });
  await database.insertAgentExecution({
    id: EXECUTION_ID,
    organizationId: "org-ack-test",
    projectId: "project-ack-test",
    machineId: null,
    daemonId: DAEMON_ID,
    triggerContext: {},
    outputContext: {},
    configurationRevisionId: "revision-ack-test",
  });
  await database.saveAgentSession({
    id: "session",
    organizationId: "org-ack-test",
    projectId: "project-ack-test",
    continuationKey: null,
    workspaceKey: null,
    workspaceResolution: null,
    daemonId: DAEMON_ID,
    agentId: AGENT_ID,
    workspaceId: "workspace",
    compatibility: "test",
    capabilityTokenHash: "test",
    tools: [],
    creationOptions: {
      provider: "codex",
      cwd: "/workspace",
      env: {},
      toolPolicy: { preapproved: [] },
    },
  });
  await database.attachExecutionToSession(EXECUTION_ID, "session");
  await database.attachAgentToExecution(EXECUTION_ID, DAEMON_ID, AGENT_ID);
  await database.transitionAgentExecution(EXECUTION_ID, "succeeded", {
    completedByAgent: true,
    hubAction: "archive",
  });
  const connection = new AcknowledgementConnection();
  return {
    database,
    connection,
    lifecycle: createLifecycle(database, connection),
  };
}

function createLifecycle(
  database: Awaited<ReturnType<typeof createMemoryDatabase>>,
  connection: AcknowledgementConnection,
): DaemonDispatchLifecycle {
  return createDaemonDispatchLifecycle({
    database,
    publicBaseUrl: "http://hub.test",
    completionTokenSecret: "test-secret",
    connectionForDaemon: (daemonId) => (daemonId === DAEMON_ID ? connection : undefined),
  });
}

class AcknowledgementConnection implements DaemonConnection {
  readonly agents: AgentConnection = {
    create: async () => {
      throw new Error("not used");
    },
    get: async () => {
      throw new Error("not used");
    },
    send: async () => {
      throw new Error("not used");
    },
    restore: async () => {
      throw new Error("not used");
    },
    control: async (_agentId, _workspaceId, action) => {
      this.actions.push(action);
    },
    inspectWorkspace: async () => {
      throw new Error("not used");
    },
    readWorkspace: async () => {
      throw new Error("not used");
    },
    respondToPermission: async () => {
      throw new Error("not used");
    },
    watch: async (_agentId, listener) =>
      this.on((event) => {
        if (event.type === "agent_stream") listener(event);
        else
          listener({
            type: "agent_update",
            agent: {
              id: event.agentId,
              workspaceId: "workspace",
              status: event.agent.status,
              pendingPermissions: [],
            },
            timestamp: event.timestamp,
          });
      }),
  };
  readonly actions: Array<"interrupt" | "archive" | "archive_agent"> = [];
  private readonly handlers = new Set<(event: DaemonEvent) => void | Promise<void>>();

  on(handler: (event: DaemonEvent) => void | Promise<void>): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async emit(event: DaemonEvent): Promise<void> {
    for (const handler of this.handlers) await handler(event);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async emitObserved(event: DaemonEvent): Promise<void> {
    for (const handler of this.handlers) {
      await Promise.resolve(handler(event)).catch(() => undefined);
    }
  }

  async createAgent(): Promise<never> {
    throw new Error("not used");
  }

  async getProviderSnapshot(): Promise<never> {
    throw new Error("not used");
  }

  async refreshProviderSnapshot(): Promise<never> {
    throw new Error("not used");
  }
}

function toolCall(
  callId: string,
  name: string,
  status: "running" | "completed" | "failed" | "canceled",
): DaemonEvent {
  return {
    type: "agent_stream",
    executionId: EXECUTION_ID,
    agentId: AGENT_ID,
    timestamp: ACKNOWLEDGED_AT.toISOString(),
    event: {
      type: "timeline",
      provider: "test",
      item: { type: "tool_call", callId, name, status },
    },
  } as DaemonEvent;
}

function daemonRecord(): DaemonRecord {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: DAEMON_ID,
    slug: "daemon-lifecycle",
    machineId: "machine-lifecycle",
    serverId: "server-lifecycle",
    daemonPublicKey: "public-key",
    credentialVerifier: "verifier",
    permissions: ["hub.execute"],
    registeredByApiKeyId: null,
    registeredByCliCredentialId: null,
    status: "active",
    presence: "connected",
    connectedAt: now,
    disconnectedAt: null,
    lastSeenAt: now,
    createdAt: now,
  };
}

function turnCompleted(): DaemonEvent {
  return {
    type: "agent_stream",
    executionId: EXECUTION_ID,
    agentId: AGENT_ID,
    timestamp: ACKNOWLEDGED_AT.toISOString(),
    event: { type: "turn_completed", provider: "test" },
  };
}

function agentIdle(): DaemonEvent {
  return {
    type: "agent_update",
    executionId: EXECUTION_ID,
    agentId: AGENT_ID,
    timestamp: ACKNOWLEDGED_AT.toISOString(),
    agent: { id: AGENT_ID, status: "idle" },
  };
}

describe("execution control and provider stream observation", () => {
  it("tells the provider where the agent landed and forwards only that agent's stream without blocking", async () => {
    const fixture = await dispatchedFixture();
    try {
      const dispatched = fixture.dispatched[0];
      assert.ok(dispatched);
      assert.deepEqual(
        {
          executionId: dispatched.executionId,
          daemonId: dispatched.daemonId,
          agentId: dispatched.agentId,
          workspaceId: dispatched.workspaceId,
          action: dispatched.action,
          workspace: dispatched.workspace,
          triggerContext: dispatched.triggerContext,
          outputContext: dispatched.outputContext,
        },
        {
          executionId: EXECUTION_ID,
          daemonId: DAEMON_ID,
          agentId: AGENT_ID,
          workspaceId: "workspace-control",
          action: "created",
          workspace: { action: "created" },
          triggerContext: { provider: "test" },
          outputContext: { provider: "test", arrival: 1 },
        },
      );
      await dispatched.send("activity-1", "keep going");
      await dispatched.cancel();
      assert.deepEqual(fixture.connection.sends, [
        { agentId: AGENT_ID, messageId: EXECUTION_ID, text: "Work on the issue" },
        { agentId: AGENT_ID, messageId: "activity-1", text: "keep going" },
      ]);
      assert.deepEqual(fixture.connection.actions, ["interrupt"]);

      fixture.connection.emit({
        type: "agent_stream",
        agentId: "agent-of-another-execution",
        event: { type: "turn_started", provider: "codex" },
        timestamp: ACKNOWLEDGED_AT.toISOString(),
      });
      fixture.connection.emit({
        type: "agent_stream",
        agentId: AGENT_ID,
        event: { type: "turn_started", provider: "codex" },
        timestamp: ACKNOWLEDGED_AT.toISOString(),
      });
      await settle();
      assert.deepEqual(
        fixture.streamed.map((item) => [item.executionId, item.agentId, item.event.type]),
        [[EXECUTION_ID, AGENT_ID, "turn_started"]],
      );
      assert.equal(fixture.streamed[0]?.daemonId, DAEMON_ID);
      assert.deepEqual(fixture.streamed[0]?.observedAt, ACKNOWLEDGED_AT);

      // A slow provider must not delay the daemon event chain behind it.
      let releaseHook!: () => void;
      fixture.gate.hook = new Promise<void>((resolve) => {
        releaseHook = resolve;
      });
      fixture.connection.emit({
        type: "agent_stream",
        agentId: AGENT_ID,
        event: { type: "turn_completed", provider: "codex" },
        timestamp: ACKNOWLEDGED_AT.toISOString(),
      });
      fixture.connection.emit({
        type: "agent_update",
        agent: {
          id: AGENT_ID,
          workspaceId: "workspace-control",
          status: "closed",
          pendingPermissions: [],
        },
        timestamp: ACKNOWLEDGED_AT.toISOString(),
      });
      await settle();
      assert.equal((await fixture.database.findAgentExecutionById(EXECUTION_ID))?.status, "failed");
      assert.equal(fixture.lifecycle.activeExecutionObservationCount(), 0);
      releaseHook();
    } finally {
      await fixture.lifecycle.stop();
    }
  });

  it("forwards the turn start the daemon streams before acknowledging the prompt", async () => {
    const fixture = await dispatchedFixture({ streamTurnStartBeforeAck: true });
    try {
      assert.deepEqual(fixture.connection.sends, [
        { agentId: AGENT_ID, messageId: EXECUTION_ID, text: "Work on the issue" },
      ]);
      assert.deepEqual(
        fixture.streamed.map((item) => [item.executionId, item.agentId, item.event.type]),
        [[EXECUTION_ID, AGENT_ID, "turn_started"]],
      );
      assert.equal(fixture.lifecycle.activeExecutionObservationCount(), 1);
    } finally {
      await fixture.lifecycle.stop();
    }
  });

  it("provider stream hook failure is reported, not fatal", async () => {
    const canary = "linear-mirror-secret-7d21";
    const fixture = await dispatchedFixture({ streamFailure: canary });
    try {
      fixture.connection.emit({
        type: "agent_stream",
        agentId: AGENT_ID,
        event: { type: "turn_started", provider: "codex" },
        timestamp: ACKNOWLEDGED_AT.toISOString(),
      });
      await settle();
      assertOneFailure(fixture.stream, {
        operation: "daemon.provider.stream",
        component: "daemons",
        canary,
      });
      assert.equal(fixture.lifecycle.activeExecutionObservationCount(), 1);

      fixture.connection.emit({
        type: "agent_update",
        agent: {
          id: AGENT_ID,
          workspaceId: "workspace-control",
          status: "closed",
          pendingPermissions: [],
        },
        timestamp: ACKNOWLEDGED_AT.toISOString(),
      });
      await settle();
      assert.equal((await fixture.database.findAgentExecutionById(EXECUTION_ID))?.status, "failed");
      assert.equal(fixture.lifecycle.activeExecutionObservationCount(), 0);
    } finally {
      await fixture.lifecycle.stop();
    }
    assert.equal(fixture.lifecycle.activeExecutionObservationCount(), 0);
  });

  it("reports a failing dispatch hook once and keeps the execution running", async () => {
    const canary = "linear-dispatch-secret-1b0e";
    const fixture = await dispatchedFixture({ dispatchFailure: canary });
    try {
      assertOneFailure(fixture.stream, {
        operation: "daemon.provider.dispatched",
        component: "daemons",
        canary,
      });
      assert.equal(
        (await fixture.database.findAgentExecutionById(EXECUTION_ID))?.status,
        "running",
      );
    } finally {
      await fixture.lifecycle.stop();
    }
  });

  it("steers a live agent verbatim unless a permission is pending", async () => {
    const fixture = await controlFixture();
    try {
      assert.equal(await fixture.lifecycle.steer(EXECUTION_ID, "activity-1", "more"), "sent");
      assert.deepEqual(fixture.connection.sends, [
        { agentId: AGENT_ID, messageId: "activity-1", text: "more" },
      ]);

      fixture.connection.pendingPermissions = [{ id: "perm-1" }, { id: "perm-2" }];
      assert.deepEqual(await fixture.lifecycle.steer(EXECUTION_ID, "activity-2", "answer"), {
        status: "permission_pending",
        requestId: "perm-1",
      });
      assert.equal(fixture.connection.sends.length, 1);

      const spawning = await fixture.spawningExecution();
      assert.equal(await fixture.lifecycle.steer(spawning, "activity-3", "later"), "agent_pending");
      await fixture.database.transitionAgentExecution(spawning, "failed", { result: {} });
      assert.equal(await fixture.lifecycle.steer(spawning, "activity-4", "late"), "not_live");
      assert.equal(await fixture.lifecycle.steer("missing", "activity-5", "none"), "not_live");
    } finally {
      await fixture.lifecycle.stop();
    }
  });

  it("interrupts without any Hub action, including before the agent exists", async () => {
    const fixture = await controlFixture({ autoArchive: true });
    try {
      assert.equal(await fixture.lifecycle.interrupt(EXECUTION_ID, "linear_stop_requested"), true);
      assert.deepEqual(fixture.connection.actions, ["interrupt"]);
      const stopped = await fixture.database.findAgentExecutionById(EXECUTION_ID);
      assert.equal(stopped?.status, "failed");
      assert.equal(stopped?.hubAction, null);
      assert.deepEqual(stopped?.result, { status: "failed", reason: "linear_stop_requested" });
      assert.deepEqual(fixture.failures, ["linear_stop_requested"]);
      assert.equal(await fixture.lifecycle.interrupt(EXECUTION_ID, "linear_stop_requested"), false);

      const spawning = await fixture.spawningExecution({ autoArchive: true });
      assert.equal(await fixture.lifecycle.interrupt(spawning, "linear_session_dismissed"), true);
      assert.deepEqual(fixture.connection.actions, ["interrupt"]);
      const canceled = await fixture.database.findAgentExecutionById(spawning);
      assert.equal(canceled?.status, "failed");
      assert.equal(canceled?.hubAction, null);
      assert.deepEqual(canceled?.result, { status: "failed", reason: "linear_session_dismissed" });
    } finally {
      await fixture.lifecycle.stop();
    }
  });

  it("answers permissions only through a daemon allowed to write workspaces", async () => {
    const fixture = await controlFixture();
    const response = { behavior: "allow" as const, selectedActionId: "allow" };
    try {
      fixture.settings.permissions = ["hub.execute"];
      assert.equal(
        await fixture.lifecycle.respondToPermission(EXECUTION_ID, "perm-1", response),
        "permission_missing",
      );
      assert.deepEqual(fixture.connection.answers, []);

      fixture.settings.permissions = ["hub.execute", "workspace.write"];
      assert.equal(
        await fixture.lifecycle.respondToPermission(EXECUTION_ID, "perm-1", response),
        "resolved",
      );
      assert.deepEqual(fixture.connection.answers, [
        { agentId: AGENT_ID, requestId: "perm-1", response },
      ]);

      fixture.connection.answer = () => {
        throw new DaemonAgentError("Request failed: permission is already being submitted", {
          code: "handler_error",
        });
      };
      assert.deepEqual(
        await fixture.lifecycle.respondToPermission(EXECUTION_ID, "perm-1", response),
        { status: "rejected", error: "Request failed: permission is already being submitted" },
      );

      fixture.connection.answer = () => "unconfirmed";
      assert.equal(
        await fixture.lifecycle.respondToPermission(EXECUTION_ID, "perm-1", response),
        "unconfirmed",
      );

      fixture.settings.reachable = false;
      assert.equal(
        await fixture.lifecycle.respondToPermission(EXECUTION_ID, "perm-1", response),
        "unconfirmed",
      );
      fixture.settings.reachable = true;

      const spawning = await fixture.spawningExecution();
      assert.equal(
        await fixture.lifecycle.respondToPermission(spawning, "perm-1", response),
        "not_live",
      );
      await fixture.database.transitionAgentExecution(EXECUTION_ID, "succeeded");
      assert.equal(
        await fixture.lifecycle.respondToPermission(EXECUTION_ID, "perm-1", response),
        "not_live",
      );
    } finally {
      await fixture.lifecycle.stop();
    }
  });

  it("reads the session workspace's pull request and the daemon's permissions", async () => {
    const fixture = await controlFixture();
    try {
      assert.equal(await fixture.lifecycle.readWorkspacePullRequest(EXECUTION_ID), undefined);
      fixture.connection.pullRequest = { url: "https://github.com/acme/repo/pull/9", title: "Fix" };
      assert.deepEqual(await fixture.lifecycle.readWorkspacePullRequest(EXECUTION_ID), {
        url: "https://github.com/acme/repo/pull/9",
        title: "Fix",
      });
      assert.deepEqual(fixture.connection.workspaceReads, [
        "workspace-control",
        "workspace-control",
      ]);
      assert.equal(await fixture.lifecycle.readWorkspacePullRequest("missing"), undefined);

      fixture.settings.permissions = ["hub.execute", "workspace.write"];
      assert.deepEqual(await fixture.lifecycle.daemonPermissions(DAEMON_ID), [
        "hub.execute",
        "workspace.write",
      ]);
      assert.deepEqual(await fixture.lifecycle.daemonPermissions("unknown"), []);
    } finally {
      await fixture.lifecycle.stop();
    }
  });
});

function settle(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
}

function controlIntent(overrides: Partial<LaunchMachineIntent> = {}): LaunchMachineIntent {
  return {
    kind: "launch_machine",
    organizationId: "org-control",
    projectId: "project-control",
    triggerRunId: "run-control",
    triggerName: "control",
    environmentName: "runner",
    environment: { kind: "daemon", daemonId: DAEMON_ID, authoredSlug: "daemon", cwd: "/repo" },
    agent: { provider: "codex" },
    prompt: "Work on the issue",
    allowOutputs: [],
    autoArchive: false,
    triggerContext: { provider: "test" },
    outputContext: { provider: "test", arrival: 1 },
    configurationRevisionId: "revision-control",
    hubConfig: {},
    ...overrides,
  };
}

/** A daemon double whose agent, workspace and permission answers the tests configure. */
class ControlConnection implements DaemonConnection {
  readonly sends: { agentId: string; messageId: string; text: string }[] = [];
  readonly actions: string[] = [];
  readonly answers: { agentId: string; requestId: string; response: unknown }[] = [];
  readonly workspaceReads: string[] = [];
  pendingPermissions: { id: string }[] = [];
  pullRequest: { url: string; title: string } | undefined;
  answer: () => "resolved" | "unconfirmed" = () => "resolved";
  /** Like the daemon, stream the turn's start before acknowledging the prompt. */
  streamTurnStartBeforeAck = false;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  readonly agents: AgentConnection = {
    create: async () => this.snapshot(),
    get: async () => this.snapshot(),
    send: async (agentId, messageId, text) => {
      if (this.streamTurnStartBeforeAck) {
        this.emit({
          type: "agent_stream",
          agentId,
          event: { type: "turn_started", provider: "codex" },
          timestamp: ACKNOWLEDGED_AT.toISOString(),
        });
        await settle();
      }
      this.sends.push({ agentId, messageId, text });
    },
    restore: async () => true,
    control: async (_agentId, _workspaceId, action) => {
      this.actions.push(action);
    },
    inspectWorkspace: async () => ({ kind: "active" }),
    readWorkspace: async (workspaceId) => {
      this.workspaceReads.push(workspaceId);
      return {
        id: workspaceId,
        githubRuntime: this.pullRequest === undefined ? null : { pullRequest: this.pullRequest },
      };
    },
    respondToPermission: async (agentId, requestId, response) => {
      this.answers.push({ agentId, requestId, response });
      return this.answer();
    },
    watch: async (_agentId, listener) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
  };
  emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  private snapshot() {
    return {
      id: AGENT_ID,
      workspaceId: "workspace-control",
      status: "idle" as const,
      pendingPermissions: this.pendingPermissions,
    };
  }
  async getProviderSnapshot(): Promise<never> {
    throw new Error("not used");
  }
  async refreshProviderSnapshot(): Promise<never> {
    throw new Error("not used");
  }
}

async function dispatchedFixture(
  options: {
    streamFailure?: string;
    dispatchFailure?: string;
    streamTurnStartBeforeAck?: boolean;
  } = {},
) {
  const database = createMemoryDatabase();
  const stream = new FailureLogStream();
  const connection = new ControlConnection();
  connection.streamTurnStartBeforeAck = options.streamTurnStartBeforeAck ?? false;
  const dispatched: AgentDispatchNotification[] = [];
  const streamed: AgentStreamNotification[] = [];
  /** The stream hook waits on this before returning, so a test can hold it open. */
  const gate = { hook: Promise.resolve() };
  const provider: TriggerProvider = {
    name: "test",
    eventNames: ["manual.test"],
    match: () => Promise.resolve([]),
    onAgentDispatched: async (input) => {
      if (options.dispatchFailure !== undefined) throw new Error(options.dispatchFailure);
      dispatched.push(input);
    },
    onAgentStreamEvent: async (input) => {
      if (options.streamFailure !== undefined) throw new Error(options.streamFailure);
      streamed.push(input);
      await gate.hook;
    },
  };
  const intent = controlIntent();
  await database.insertAgentExecution({
    id: EXECUTION_ID,
    organizationId: intent.organizationId,
    projectId: intent.projectId,
    machineId: null,
    daemonId: DAEMON_ID,
    triggerContext: intent.triggerContext,
    outputContext: intent.outputContext,
    configurationRevisionId: intent.configurationRevisionId,
    launchIntent: intent,
  });
  const lifecycle = createDaemonDispatchLifecycle({
    database,
    connectionForDaemon: () => connection,
    publicBaseUrl: "https://hub.test",
    completionTokenSecret: "test-secret",
    providers: [provider],
    test: { logger: createLogger(stream) },
  });
  await lifecycle.recoverDaemon(daemonRecord());
  await settle();
  return { database, stream, connection, dispatched, streamed, gate, lifecycle };
}

async function controlFixture(overrides: Partial<LaunchMachineIntent> = {}) {
  const database = createMemoryDatabase();
  const connection = new ControlConnection();
  const failures: string[] = [];
  /** What the daemon record and registry report; tests change it between calls. */
  const settings = { permissions: ["hub.execute"], reachable: true };
  const spawningExecution = async (intentOverrides: Partial<LaunchMachineIntent> = {}) => {
    const intent = controlIntent(intentOverrides);
    const execution = await database.insertAgentExecution({
      organizationId: intent.organizationId,
      projectId: intent.projectId,
      machineId: null,
      daemonId: DAEMON_ID,
      triggerContext: intent.triggerContext,
      outputContext: intent.outputContext,
      configurationRevisionId: intent.configurationRevisionId,
      launchIntent: intent,
    });
    return execution.id;
  };
  const intent = controlIntent(overrides);
  await database.insertAgentExecution({
    id: EXECUTION_ID,
    organizationId: intent.organizationId,
    projectId: intent.projectId,
    machineId: null,
    daemonId: DAEMON_ID,
    triggerContext: intent.triggerContext,
    outputContext: intent.outputContext,
    configurationRevisionId: intent.configurationRevisionId,
    launchIntent: intent,
  });
  await database.saveAgentSession({
    id: "session-control",
    organizationId: intent.organizationId,
    projectId: intent.projectId,
    continuationKey: "linear:session:1",
    workspaceKey: "linear:issue:1",
    workspaceResolution: null,
    daemonId: DAEMON_ID,
    agentId: AGENT_ID,
    workspaceId: "workspace-control",
    compatibility: "test",
    capabilityTokenHash: "test",
    tools: [],
    creationOptions: { provider: "codex", cwd: "/repo", env: {}, toolPolicy: { preapproved: [] } },
  });
  await database.attachExecutionToSession(EXECUTION_ID, "session-control", "created");
  await database.attachAgentToExecution(EXECUTION_ID, DAEMON_ID, AGENT_ID);
  await database.transitionAgentExecution(EXECUTION_ID, "running");
  vi.spyOn(database, "findDaemonById").mockImplementation(async (id) =>
    id === DAEMON_ID ? { ...daemonRecord(), permissions: settings.permissions } : undefined,
  );
  const lifecycle = createDaemonDispatchLifecycle({
    database,
    connectionForDaemon: () => (settings.reachable ? connection : undefined),
    publicBaseUrl: "https://hub.test",
    completionTokenSecret: "test-secret",
    providers: [
      {
        name: "test",
        eventNames: ["manual.test"],
        match: () => Promise.resolve([]),
        onAgentExecutionFailed: async (_triggerContext, _outputContext, reason) => {
          failures.push(reason);
        },
      },
    ],
  });
  return { database, connection, failures, settings, lifecycle, spawningExecution };
}
