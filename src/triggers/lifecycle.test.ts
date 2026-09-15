import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type {
  AgentDispatchNotification,
  AgentStreamNotification,
  ExternalTrigger,
  TriggerProvider,
} from "./index.js";
import {
  notifyAgentDispatched,
  notifyAgentExecutionCompleted,
  notifyAgentExecutionFailed,
  notifyAgentExecutionStarted,
  notifyAgentStreamEvent,
  notifyMachineTerminated,
} from "./lifecycle.js";

describe("trigger provider lifecycle hooks", () => {
  it("fires completed, failed, and machine terminated hooks with the correct contexts", async () => {
    const calls: unknown[] = [];
    const provider = createStubProvider(calls);
    const triggerContext = { channel: "internal", messageId: "message-1" };
    const outputContext = { channel: "internal", threadId: "thread-1" };

    await notifyAgentExecutionStarted({
      provider,
      triggerContext,
      outputContext,
    });
    await notifyAgentExecutionCompleted({
      provider,
      triggerContext,
      outputContext,
      result: { status: "succeeded", summary: "done" },
    });
    await notifyAgentExecutionFailed({
      provider,
      triggerContext,
      outputContext,
      reason: "agent_failed",
    });
    await notifyMachineTerminated({
      provider,
      triggerContext,
      reason: "daemon_disconnected_mid_execution",
    });

    assert.deepEqual(calls, [
      ["started", triggerContext, outputContext],
      ["completed", triggerContext, outputContext, { status: "succeeded", summary: "done" }],
      ["failed", triggerContext, outputContext, "agent_failed"],
      ["terminated", triggerContext, "daemon_disconnected_mid_execution"],
    ]);
  });

  it("fires only onMachineTerminated when launch fails before any execution starts", async () => {
    const calls: unknown[] = [];
    const provider = createStubProvider(calls);
    const triggerContext = { channel: "internal", messageId: "message-1" };

    await notifyMachineTerminated({
      provider,
      triggerContext,
      reason: "launch_failed",
    });

    assert.deepEqual(calls, [["terminated", triggerContext, "launch_failed"]]);
  });

  it("hands dispatch and stream notifications to the provider whole, without reaction state", async () => {
    const calls: unknown[] = [];
    const provider = createStubProvider(calls);
    const dispatched: AgentDispatchNotification = {
      executionId: "execution-1",
      daemonId: "daemon-1",
      agentId: "agent-1",
      workspaceId: "workspace-1",
      action: "created",
      workspace: { action: "recreated", unrecoverableReason: "worktree_branch_missing" },
      triggerContext: { channel: "internal" },
      outputContext: { channel: "internal" },
      send: async () => {},
      cancel: async () => {},
    };
    const streamed: AgentStreamNotification = {
      executionId: "execution-1",
      agentId: "agent-1",
      daemonId: "daemon-1",
      triggerContext: { channel: "internal" },
      outputContext: { channel: "internal" },
      event: { type: "turn_started", provider: "codex" },
      observedAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    await notifyAgentDispatched({ provider, notification: dispatched });
    await notifyAgentStreamEvent({ provider, notification: streamed });

    assert.deepEqual(calls, [
      ["dispatched", dispatched],
      ["stream", streamed],
    ]);
  });

  it("tolerates providers without dispatch or stream hooks", async () => {
    const provider: TriggerProvider = {
      name: "stub",
      eventNames: ["stub.event"],
      match: async () => [],
    };
    await notifyAgentDispatched({
      provider,
      notification: {
        executionId: "execution-1",
        daemonId: "daemon-1",
        agentId: "agent-1",
        workspaceId: "workspace-1",
        action: "continued",
        workspace: { action: "reused" },
        triggerContext: {},
        outputContext: {},
        send: async () => {},
        cancel: async () => {},
      },
    });
    await notifyAgentStreamEvent({
      provider,
      notification: {
        executionId: "execution-1",
        agentId: "agent-1",
        daemonId: "daemon-1",
        triggerContext: {},
        outputContext: {},
        event: { type: "turn_completed", provider: "codex" },
        observedAt: new Date(),
      },
    });
  });
});

function createStubProvider(calls: unknown[]): TriggerProvider {
  return {
    name: "stub",
    eventNames: ["stub.event"],
    async match(_trigger: ExternalTrigger) {
      return [];
    },
    async onAgentExecutionStarted(triggerContext, outputContext) {
      calls.push(["started", triggerContext, outputContext]);
    },
    async onAgentExecutionCompleted(triggerContext, outputContext, result) {
      calls.push(["completed", triggerContext, outputContext, result]);
    },
    async onAgentExecutionFailed(triggerContext, outputContext, reason) {
      calls.push(["failed", triggerContext, outputContext, reason]);
    },
    async onMachineTerminated(triggerContext, reason) {
      calls.push(["terminated", triggerContext, reason]);
    },
    async onAgentDispatched(notification) {
      calls.push(["dispatched", notification]);
    },
    async onAgentStreamEvent(notification) {
      calls.push(["stream", notification]);
    },
  };
}
