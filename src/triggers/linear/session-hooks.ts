import type { Database } from "../../db/types.js";
import { reportFailure } from "../../failures/index.js";
import {
  linearConnectionRequiresReauthorization,
  type LinearApiClient,
} from "../../providers/linear/client.js";
import type { TriggerProvider, TriggerProviderReactionState } from "../index.js";
import { deriveLinearActivityId } from "./activity-id.js";
import { isLinearIdleReason, LINEAR_COPY, linearErrorFor } from "./copy.js";
import type { LinearMirror } from "./mirror.js";
import type {
  LinearOutputContext,
  LinearSessionEventContext,
  LinearTriggerContext,
} from "./provider.js";
import type { LinearSessionCoordinator, LinearSessionTarget } from "./session-coordinator.js";

export type LinearReactionPhase = "accepted" | "started" | "completed" | "failed";

export interface LinearSessionHookDependencies {
  coordinator: LinearSessionCoordinator;
  mirror: LinearMirror;
  database: Pick<
    Database,
    | "findLinearAgentSession"
    | "updateLinearAgentSession"
    | "takeLinearPendingPrompts"
    | "findAgentExecutionById"
    | "findLinearConnection"
  >;
  client?: Pick<LinearApiClient, "readIssue" | "updateIssue"> | undefined;
}

type SessionHooks = Pick<
  TriggerProvider<"linear", LinearTriggerContext, LinearOutputContext>,
  | "onDispatchAccepted"
  | "onAgentExecutionStarted"
  | "onAgentDispatched"
  | "onAgentStreamEvent"
  | "onAgentExecutionCompleted"
  | "onAgentExecutionFailed"
  | "onMachineTerminated"
  | "onAgentExecutionTerminal"
>;

export function linearReactionPhase(
  state: TriggerProviderReactionState | undefined,
): LinearReactionPhase | undefined {
  if (typeof state !== "object" || state === null || Array.isArray(state)) return undefined;
  const phase = Reflect.get(state, "phase");
  return phase === "accepted" || phase === "started" || phase === "completed" || phase === "failed"
    ? phase
    : undefined;
}

/**
 * Run-level and execution-level lifecycle hooks for agent-session contexts. Issue and comment
 * contexts keep their historical behaviour (no reaction). A connection that requires
 * reauthorization short-circuits every emission: the phase is still recorded so the engine stops
 * redelivering the notification.
 */
export function createLinearSessionHooks(deps: LinearSessionHookDependencies): SessionHooks {
  const { coordinator, mirror, database } = deps;

  async function revoked(linear: LinearSessionEventContext): Promise<boolean> {
    const connection = await database.findLinearConnection(linear.organization.id);
    return connection === undefined || linearConnectionRequiresReauthorization(connection);
  }

  async function failed(
    linear: LinearSessionEventContext,
    reason: string,
    reactionState: TriggerProviderReactionState | undefined,
  ): Promise<TriggerProviderReactionState> {
    if (linearReactionPhase(reactionState) === "failed") return reactionState ?? null;
    const phase = { phase: "failed" };
    if (await revoked(linear)) return phase;
    const target = targetOf(linear);
    const record = await database.findLinearAgentSession(target.sessionId);
    if (record === undefined || record.respondedAt !== null) return phase;
    const executionId = record.currentExecutionId ?? linear.delivery_id;
    if (reason === "linear_stop_requested") {
      await coordinator.emit(
        target,
        {
          kind: "activity",
          id: deriveLinearActivityId(`${target.sessionId}:execution:${executionId}:stopped`),
          content: {
            type: "response",
            body: LINEAR_COPY.stopped(coordinator.stopRequestedBy(target.sessionId)),
          },
          ephemeral: false,
        },
        { closeAfter: true },
      );
      return phase;
    }
    if (reason === "linear_issue_unassigned") {
      await coordinator.emit(
        target,
        {
          kind: "activity",
          id: deriveLinearActivityId(`${target.sessionId}:execution:${executionId}:stopped`),
          content: { type: "response", body: LINEAR_COPY.unassigned },
          ephemeral: false,
        },
        { closeAfter: true },
      );
      return phase;
    }
    if (reason === "linear_session_dismissed") return phase;
    if (isLinearIdleReason(reason) && record.mirrorStatus === "awaitingInput") return phase;
    const result = await coordinator.emit(target, {
      kind: "activity",
      id: deriveLinearActivityId(`${target.sessionId}:execution:${executionId}:error`),
      content: { type: "error", body: linearErrorFor(reason) },
      ephemeral: false,
    });
    if (result === "failed") throw new Error("Linear error activity could not be delivered");
    return phase;
  }

  return {
    async onDispatchAccepted(context, _outputContext, reactionState) {
      const linear = context.event.linear;
      if (linear.event_type !== "agent_session") return reactionState ?? null;
      if (linearReactionPhase(reactionState) !== undefined) return reactionState ?? null;
      if (!(await revoked(linear))) {
        const target = targetOf(linear);
        void coordinator.emit(target, {
          kind: "activity",
          id: deriveLinearActivityId(`${target.sessionId}:accepted:${linear.delivery_id}`),
          content: { type: "thought", body: LINEAR_COPY.queued },
          ephemeral: true,
        });
      }
      return { phase: "accepted" };
    },

    async onAgentExecutionStarted(context, _outputContext, reactionState) {
      const linear = context.event.linear;
      if (linear.event_type !== "agent_session") return reactionState ?? null;
      const phase = linearReactionPhase(reactionState);
      if (phase === "started" || phase === "completed" || phase === "failed") {
        return reactionState ?? null;
      }
      if (await revoked(linear)) return { phase: "started" };
      const target = targetOf(linear);
      void coordinator.emit(target, {
        kind: "activity",
        id: deriveLinearActivityId(`${target.sessionId}:started:${linear.delivery_id}`),
        content: { type: "thought", body: LINEAR_COPY.started },
        ephemeral: true,
      });
      if (linear.creator !== null && linear.authority !== null && deps.client !== undefined) {
        await applyStartAuthority(deps.client, coordinator, linear, linear.authority, target);
      }
      return { phase: "started" };
    },

    async onAgentDispatched(input) {
      const linear = input.triggerContext.event.linear;
      if (linear.event_type !== "agent_session") return;
      const target = targetOf(linear);
      const execution = await database.findAgentExecutionById(input.executionId);
      if (
        execution === undefined ||
        (execution.status !== "spawning" && execution.status !== "running")
      ) {
        await input.cancel();
        return;
      }
      await database.updateLinearAgentSession(target.sessionId, {
        daemonId: input.daemonId,
        daemonAgentId: input.agentId,
        daemonWorkspaceId: input.workspaceId,
        currentExecutionId: input.executionId,
        agentSessionId: execution.agentSessionId,
        mirrorStatus: "active",
        respondedAt: null,
        stopRequestedAt: null,
      });
      coordinator.reopen(target);
      let prompts = await database.takeLinearPendingPrompts(target.sessionId);
      while (prompts.length > 0) {
        for (const prompt of prompts) await input.send(prompt.activityId, prompt.body);
        prompts = await database.takeLinearPendingPrompts(target.sessionId);
      }
      if (input.workspace.action === "recreated") {
        void coordinator.emit(target, {
          kind: "activity",
          content: {
            type: "thought",
            body: LINEAR_COPY.workspaceUnrecoverable(
              input.workspace.unrecoverableReason ?? "unknown reason",
            ),
          },
          ephemeral: false,
        });
      }
      coordinator.armKeepalive(target);
    },

    onAgentStreamEvent: (input) => mirror.observe(input),

    async onAgentExecutionCompleted(context, _outputContext, _result, reactionState) {
      const linear = context.event.linear;
      if (linear.event_type !== "agent_session") return reactionState ?? null;
      const phase = linearReactionPhase(reactionState);
      if (phase === "completed" || phase === "failed") return reactionState ?? null;
      if (await revoked(linear)) return { phase: "completed" };
      const target = targetOf(linear);
      const record = await database.findLinearAgentSession(target.sessionId);
      if (record !== undefined && record.respondedAt === null) {
        const result = await coordinator.emit(target, {
          kind: "activity",
          id: deriveLinearActivityId(
            `${target.sessionId}:execution:${record.currentExecutionId ?? linear.delivery_id}:completed`,
          ),
          content: {
            type: "response",
            body: record.lastAssistantMessage ?? LINEAR_COPY.runCompleted,
          },
          ephemeral: false,
        });
        if (result === "failed") throw new Error("Linear response could not be delivered");
      }
      if (linear.creator !== null && linear.authority?.onComplete !== undefined) {
        await coordinator.transitionIssue({
          linearOrganizationId: linear.organization.id,
          issueId: linear.issue.id,
          teamId: linear.team.id,
          selector: linear.authority.onComplete,
        });
      }
      return { phase: "completed" };
    },

    async onAgentExecutionFailed(context, _outputContext, reason, reactionState) {
      const linear = context.event.linear;
      if (linear.event_type !== "agent_session") return reactionState ?? null;
      return failed(linear, reason, reactionState);
    },

    async onMachineTerminated(context, reason, reactionState) {
      const linear = context.event.linear;
      if (linear.event_type !== "agent_session") return reactionState ?? null;
      return failed(linear, reason, reactionState);
    },

    async onAgentExecutionTerminal(executionId, context) {
      const linear = context.event.linear;
      if (linear.event_type !== "agent_session") return;
      const target = targetOf(linear);
      const record = await database.findLinearAgentSession(target.sessionId);
      if (record?.currentExecutionId === executionId) {
        await database.updateLinearAgentSession(target.sessionId, {
          currentExecutionId: null,
          pendingPermission: null,
        });
      }
      coordinator.disarmKeepalive(target.sessionId);
      mirror.forget(executionId);
    },
  };
}

/** `on_start` and `delegate` apply only to sessions a human created (never to automations). */
async function applyStartAuthority(
  client: Pick<LinearApiClient, "readIssue" | "updateIssue">,
  coordinator: Pick<LinearSessionCoordinator, "transitionIssue">,
  linear: LinearSessionEventContext,
  authority: NonNullable<LinearSessionEventContext["authority"]>,
  target: LinearSessionTarget,
): Promise<void> {
  try {
    const issue = await client.readIssue({
      linearOrganizationId: linear.organization.id,
      issueId: linear.issue.id,
    });
    const stateType = issue?.state?.type;
    const settled =
      stateType === "started" || stateType === "completed" || stateType === "canceled";
    if (authority.onStart !== undefined && !settled) {
      await coordinator.transitionIssue({
        linearOrganizationId: linear.organization.id,
        issueId: linear.issue.id,
        teamId: linear.team.id,
        selector: authority.onStart,
      });
    }
    if (authority.delegate && (issue?.delegateId ?? null) === null) {
      await client.updateIssue({
        linearOrganizationId: linear.organization.id,
        issueId: linear.issue.id,
        delegateId: linear.app_user.id,
      });
    }
  } catch (error) {
    reportFailure(
      error,
      { component: "triggers", operation: "linear.issue.start", provider: "linear" },
      { diagnostic: { sessionId: target.sessionId } },
    );
  }
}

function targetOf(linear: LinearSessionEventContext): LinearSessionTarget {
  return { sessionId: linear.session.id, linearOrganizationId: linear.organization.id };
}
