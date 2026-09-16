import type { LinearStateSelector } from "../../config/linear-authority.js";
import type { AgentPermissionResponse } from "../../daemons/agents/index.js";
import type { ExecutionControl } from "../../daemons/execution-control.js";
import type {
  Database,
  LinearAgentSessionPatch,
  LinearAgentSessionRecord,
  LinearLifecycleReceiptClaim,
  LinearPendingPermission,
} from "../../db/types.js";
import { reportFailure } from "../../failures/index.js";
import { logger } from "../../logger.js";
import {
  LinearApiError,
  type LinearActivityContent,
  type LinearPlanStep,
} from "../../providers/linear/client.js";
import type { ProviderEventDropReasonCode } from "../drop-reason.js";
import { deriveLinearActivityId } from "./activity-id.js";
import {
  LinearActivityQueue,
  type LinearEmitResult,
  type LinearOutboundActivity,
} from "./activity-queue.js";
import { LINEAR_COPY } from "./copy.js";
import type { NormalizedLinearAgentSessionEvent } from "./events.js";
import type { LinearLifecycleEvent } from "./lifecycle-events.js";
import type { LinearSessionState } from "./session-state.js";

export const LINEAR_KEEPALIVE_MS = 25 * 60_000;
const TEAM_STATES_TTL_MS = 5 * 60_000;
const LINEAR_DEADLOCK_RETRY_DELAYS_MS = [700, 2_000, 5_000] as const;
const GITHUB_PULL_REQUEST_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/u;

export type LinearSessionCoordinatorDatabase = Pick<
  Database,
  | "upsertLinearAgentSession"
  | "findLinearAgentSession"
  | "updateLinearAgentSession"
  | "appendLinearPendingPrompt"
  | "takeLinearPendingPrompts"
  | "listLinearAgentSessionsForIssue"
  | "findLinearConnection"
  | "applyLinearLifecycle"
  | "findOrganizationSlug"
  | "findAgentExecutionById"
>;

/** The subset of `setTimeout` the coordinator and its queues use; injectable for tests. */
export type LinearSessionCoordinatorTimer = (
  callback: () => void,
  delay: number,
) => ReturnType<typeof setTimeout>;

export interface LinearSessionCoordinatorOptions {
  state: LinearSessionState;
  control: ExecutionControl;
  database: LinearSessionCoordinatorDatabase;
  publicBaseUrl: string;
  now?: () => Date;
  setTimeout?: LinearSessionCoordinatorTimer;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** Identifies the Linear session a mutation targets; both ids are needed for the API call. */
export interface LinearSessionTarget {
  sessionId: string;
  linearOrganizationId: string;
}

export type LinearFollowUpOutcome =
  | "steered"
  | "queued"
  | "answered_permission"
  | "stopped"
  | "forked"
  | "dispatch";

/**
 * Shared by the webhook, the trigger provider, the output executors and the mirror of one Linear
 * registration: everything that reads or writes `linear_agent_sessions` or talks to a session.
 * Nothing here awaits the daemon on the webhook path; daemon calls are detached and reported.
 */
export class LinearSessionCoordinator {
  /** Names of the people who requested a stop, by session; only used for the final wording. */
  private readonly stopRequesters = new Map<string, string | undefined>();

  constructor(private readonly options: LinearSessionCoordinatorOptions) {}

  /** Database work only: registers the session and queues the acknowledgement. */
  async acknowledge(
    event: NormalizedLinearAgentSessionEvent,
    input: { connectionId: string; organizationId: string },
  ): Promise<void> {
    const { record, created } = await this.upsert(event, input);
    if (event.action !== "created" || !created) return;
    const target = targetOf(record);
    void this.emit(
      target,
      {
        kind: "activity",
        id: deriveLinearActivityId(`${record.linearSessionId}:ack`),
        content: { type: "thought", body: LINEAR_COPY.ack },
        ephemeral: true,
        priority: "ack",
      },
      { head: true },
    );
    const slug = await this.options.database.findOrganizationSlug(input.organizationId);
    if (slug !== undefined) {
      void this.updateSession(target, {
        addedExternalUrls: [
          { label: "Paseo Hub", url: `${this.options.publicBaseUrl}/o/${slug}/activity` },
        ],
      });
    }
    const identifier = record.issueIdentifier ?? event.session.issue?.identifier ?? "";
    const summary = normalizeLinearSummary(`${identifier} - ${event.session.issue?.title ?? ""}`);
    if (summary !== undefined) void this.updateSession(target, { summary });
    this.armKeepalive(target);
  }

  /**
   * Routes a `prompted` activity: stop, permission answer, steer of the live turn, or a new run
   * (`dispatch`, the only outcome for which the webhook calls the trigger handlers).
   */
  async followUp(
    event: NormalizedLinearAgentSessionEvent,
    input: { connectionId: string; organizationId: string },
  ): Promise<LinearFollowUpOutcome> {
    const activity = event.activity;
    if (activity === null) return "dispatch";
    const record =
      (await this.options.database.findLinearAgentSession(event.session.id)) ??
      (await this.upsert(event, input)).record;
    const target = targetOf(record);
    if (activity.signal === "stop") {
      await this.stop(record, activity.user.name);
      return "stopped";
    }
    if (await this.forkOntoComment(event, activity)) return "forked";
    if (record.pendingPermission !== null) {
      void this.answerPermission(record, record.pendingPermission, activity.body).catch(
        (error: unknown) => this.report(error, "linear.permission.answer", record),
      );
      return "answered_permission";
    }
    if (record.currentExecutionId !== null && record.respondedAt === null) {
      const execution = await this.options.database.findAgentExecutionById(
        record.currentExecutionId,
      );
      if (execution !== undefined && isLiveStatus(execution.status)) {
        if (execution.daemonAgentId === null) {
          await this.queuePrompt(record, activity);
          return "queued";
        }
        void this.steer(record, record.currentExecutionId, activity).catch((error: unknown) =>
          this.report(error, "linear.follow_up.steer", record),
        );
        return "steered";
      }
    }
    void this.emit(target, ephemeralThought(LINEAR_COPY.followUpReceived));
    return "dispatch";
  }

  /**
   * Linear funnels every later mention on an issue into the session it already has, so an answer
   * written as a session activity lands in that session's thread and the person who commented
   * never sees it. When the prompt comes from another thread, open a session on that thread
   * instead: Linear then renders the agent's activities and its answer under the comment, and
   * sends a `created` event that starts the run. Returns false when the prompt is already in the
   * session's own thread, which needs no forking.
   */
  /**
   * A reply posted in a thread without mentioning the agent produces no session event at all,
   * only this notification. Linear's own example agent answers exactly when the agent already
   * wrote in that thread, which keeps it out of conversations between people while letting it
   * follow up on its own answers. Opening a session on the thread root is what makes its
   * activities and its reply render under the comment.
   */
  private async wakeOnThreadReply(event: Extract<LinearLifecycleEvent, { kind: "notification" }>) {
    const client = this.options.state.client;
    const rootCommentId = event.notification.parentCommentId;
    if (client === undefined || rootCommentId === null || rootCommentId === undefined) return;
    if (event.notification.actorId === event.appUserId) return;
    try {
      const authors = await client.readCommentThreadAuthors({
        linearOrganizationId: event.organizationId,
        rootCommentId,
      });
      if (!authors.includes(event.appUserId)) return;
      const opened = await this.retryOnDeadlock(() =>
        client.createAgentSessionOnComment({
          linearOrganizationId: event.organizationId,
          commentId: rootCommentId,
        }),
      );
      logger.info(
        { commentId: rootCommentId, sessionId: opened.id },
        "opened a Linear agent session on a reply in the agent's own thread",
      );
    } catch (error) {
      this.report(error, "linear.thread_reply.wake");
    }
  }

  private async forkOntoComment(
    event: NormalizedLinearAgentSessionEvent,
    activity: NonNullable<NormalizedLinearAgentSessionEvent["activity"]>,
  ): Promise<boolean> {
    const client = this.options.state.client;
    const sourceCommentId = activity.sourceCommentId;
    if (client === undefined || sourceCommentId === null) return false;
    try {
      const root = await client.readCommentThreadRoot({
        linearOrganizationId: event.organizationId,
        commentId: sourceCommentId,
      });
      if (root === undefined || root === event.session.commentId) return false;
      // Linear is still writing the prompt activity onto the other session when we ask it to open
      // a session on the same comment, and reports the lock conflict as DEADLOCK_DETECTED.
      const forked = await this.retryOnDeadlock(() =>
        client.createAgentSessionOnComment({
          linearOrganizationId: event.organizationId,
          commentId: root,
        }),
      );
      logger.info(
        { sessionId: event.session.id, forkedSessionId: forked.id, commentId: root },
        "opened a Linear agent session on the commented thread",
      );
      return true;
    } catch (error) {
      // The answer still reaches the session's own thread; losing the fork is not losing the reply.
      this.report(error, "linear.session.fork");
      return false;
    }
  }

  private async retryOnDeadlock<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const retriable =
          error instanceof LinearApiError && error.code === "DEADLOCK_DETECTED" && attempt < 3;
        if (!retriable) throw error;
        await new Promise<void>((resolve) => {
          (this.options.setTimeout ?? globalThis.setTimeout)(
            () => resolve(),
            LINEAR_DEADLOCK_RETRY_DELAYS_MS[attempt] ?? 3_000,
          );
        });
      }
    }
  }

  /** A `stop` signal: no run, no archive, a final response by the failing execution's hook. */
  async stop(record: LinearAgentSessionRecord, requestedBy?: string): Promise<void> {
    const now = this.now();
    this.stopRequesters.set(record.linearSessionId, requestedBy);
    await this.options.database.updateLinearAgentSession(record.linearSessionId, {
      stopRequestedAt: now,
      pendingPermission: null,
    });
    await this.options.database.takeLinearPendingPrompts(record.linearSessionId);
    this.queueFor(targetOf(record)).purge();
    this.disarmKeepalive(record.linearSessionId);
    if (record.currentExecutionId !== null) {
      const execution = await this.options.database.findAgentExecutionById(
        record.currentExecutionId,
      );
      if (execution !== undefined && isLiveStatus(execution.status)) {
        void this.options.control
          .interrupt(record.currentExecutionId, "linear_stop_requested")
          .catch((error: unknown) => this.report(error, "linear.stop.interrupt", record));
        return;
      }
    }
    await this.emit(
      targetOf(record),
      {
        kind: "activity",
        content: { type: "response", body: LINEAR_COPY.nothingRunning },
        ephemeral: false,
      },
      { closeAfter: true },
    );
  }

  stopRequestedBy(sessionId: string): string | undefined {
    return this.stopRequesters.get(sessionId);
  }

  /** Best-effort: tells the person why nothing will happen; never blocks the webhook. */
  reportDrop(
    event: NormalizedLinearAgentSessionEvent,
    reason: ProviderEventDropReasonCode | "linear_unbound",
  ): void {
    if (reason === "linear_unbound") return;
    const body =
      reason === "configuration_unavailable"
        ? LINEAR_COPY.dropConfiguration
        : LINEAR_COPY.dropNoProject;
    void this.emit(
      { sessionId: event.session.id, linearOrganizationId: event.organizationId },
      { kind: "activity", content: { type: "error", body }, ephemeral: false },
    );
  }

  reportDispatchFailure(event: NormalizedLinearAgentSessionEvent): void {
    void this.emit(
      { sessionId: event.session.id, linearOrganizationId: event.organizationId },
      {
        kind: "activity",
        content: { type: "error", body: LINEAR_COPY.dispatchFailed },
        ephemeral: false,
      },
    );
  }

  /** Permission changes, de-authorization and inbox notifications addressed to the app user. */
  async applyLifecycle(
    event: LinearLifecycleEvent,
    claim: Extract<LinearLifecycleReceiptClaim, { status: "claimed" }>,
  ): Promise<void> {
    if (event.kind === "revoked") {
      await this.options.database.applyLinearLifecycle(claim, { kind: "revoked" });
      logger.info(
        { linearOrganizationId: claim.linearOrganizationId },
        "Linear app authorization revoked; connection requires reauthorization",
      );
      return;
    }
    if (event.kind === "permission_change") {
      const connection = await this.options.database.findLinearConnection(
        claim.linearOrganizationId,
      );
      const teamIds = new Set(connection?.teamAccess?.teamIds ?? []);
      for (const teamId of event.addedTeamIds) teamIds.add(teamId);
      for (const teamId of event.removedTeamIds) teamIds.delete(teamId);
      const teamAccess = {
        canAccessAllPublicTeams: event.canAccessAllPublicTeams,
        teamIds: [...teamIds],
        updatedAt: this.now().toISOString(),
      };
      await this.options.database.applyLinearLifecycle(claim, { kind: "team_access", teamAccess });
      logger.info(
        { linearOrganizationId: claim.linearOrganizationId, teamIds: teamAccess.teamIds },
        "Linear team access updated",
      );
      return;
    }
    if (event.action === "issueNewComment") {
      await this.wakeOnThreadReply(event);
      await this.options.database.applyLinearLifecycle(claim, { kind: "noop" });
      return;
    }
    if (event.action === "issueUnassignedFromYou" && event.notification.issueId !== undefined) {
      const sessions = await this.options.database.listLinearAgentSessionsForIssue(
        claim.linearOrganizationId,
        event.notification.issueId,
      );
      for (const record of sessions) {
        if (record.currentExecutionId === null) continue;
        void this.options.control
          .interrupt(record.currentExecutionId, "linear_issue_unassigned")
          .catch((error: unknown) => this.report(error, "linear.unassigned.interrupt", record));
      }
    }
    await this.options.database.applyLinearLifecycle(claim, { kind: "noop" });
    logger.info(
      { linearOrganizationId: claim.linearOrganizationId, action: event.action },
      "Linear app user notification received",
    );
  }

  emit(
    target: LinearSessionTarget,
    item: LinearOutboundActivity,
    options?: { head?: boolean; closeAfter?: boolean },
  ): Promise<LinearEmitResult> {
    return this.queueFor(target).enqueue(item, options);
  }

  updateSession(
    target: LinearSessionTarget,
    input: {
      plan?: readonly LinearPlanStep[];
      addedExternalUrls?: readonly { label: string; url: string }[];
      summary?: string;
      coalesceKey?: string;
    },
  ): Promise<LinearEmitResult> {
    return this.queueFor(target).enqueue({ kind: "session", ...input });
  }

  /** Reopens the session's queue for a new execution (a stop closes it). */
  reopen(target: LinearSessionTarget): void {
    this.queueFor(target).reopen();
  }

  /**
   * Publishes a pull request exactly once: as an external link on the session (recorded on the
   * first success so a retry never duplicates it), as an issue attachment, then as a state change
   * when the trigger holds that authority. Nothing here fails the caller.
   */
  async publishPullRequest(input: {
    target: LinearSessionTarget;
    issueId: string;
    url: string;
    title?: string;
    transition?: { teamId: string; selector: LinearStateSelector } | undefined;
  }): Promise<void> {
    const record = await this.options.database.findLinearAgentSession(input.target.sessionId);
    if (record?.pullRequestUrl === input.url) return;
    const result = await this.updateSession(input.target, {
      addedExternalUrls: [{ label: input.title ?? "Pull request", url: input.url }],
    });
    if (result !== "sent") return;
    await this.options.database.updateLinearAgentSession(input.target.sessionId, {
      pullRequestUrl: input.url,
    });
    const client = this.options.state.client;
    if (client === undefined) return;
    const link = {
      linearOrganizationId: input.target.linearOrganizationId,
      issueId: input.issueId,
      url: input.url,
      ...(input.title === undefined ? {} : { title: input.title }),
    };
    try {
      await client.linkGitHubPullRequest(link);
    } catch {
      try {
        await client.linkUrl(link);
      } catch (error) {
        this.report(error, "linear.pull_request.attach", record);
      }
    }
    if (input.transition !== undefined) {
      await this.transitionIssue({
        linearOrganizationId: input.target.linearOrganizationId,
        issueId: input.issueId,
        teamId: input.transition.teamId,
        selector: input.transition.selector,
      });
    }
  }

  /** Moves the issue to the selected workflow state; unresolvable selectors are reported only. */
  async transitionIssue(input: {
    linearOrganizationId: string;
    issueId: string;
    teamId: string;
    selector: LinearStateSelector;
  }): Promise<void> {
    const client = this.options.state.client;
    if (client === undefined) return;
    const stateId = await this.resolveState(input);
    if (stateId === undefined) return;
    try {
      await client.updateIssue({
        linearOrganizationId: input.linearOrganizationId,
        issueId: input.issueId,
        stateId,
      });
    } catch (error) {
      this.report(error, "linear.issue.transition");
    }
  }

  async resolveState(input: {
    linearOrganizationId: string;
    teamId: string;
    selector: LinearStateSelector;
  }): Promise<string | undefined> {
    const client = this.options.state.client;
    if (client === undefined) return undefined;
    const key = `${input.linearOrganizationId}:${input.teamId}`;
    const cached = this.options.state.teamStates.get(key);
    const now = this.now().getTime();
    let states =
      cached !== undefined && now - cached.readAt < TEAM_STATES_TTL_MS ? cached.states : undefined;
    if (states === undefined) {
      try {
        states = await client.readTeamStates({
          linearOrganizationId: input.linearOrganizationId,
          teamId: input.teamId,
        });
        this.options.state.teamStates.set(key, { readAt: now, states });
      } catch (error) {
        this.report(error, "linear.issue.state.resolve");
        return undefined;
      }
    }
    const selector = input.selector;
    const match =
      selector.kind === "name"
        ? states.find((state) => state.name === selector.name)
        : states
            .filter((state) => state.type === selector.type)
            .sort((left, right) => left.position - right.position)[0];
    if (match === undefined) {
      reportFailure(
        new Error("Linear workflow state not found"),
        { component: "triggers", operation: "linear.issue.state.resolve", provider: "linear" },
        { diagnostic: { teamId: input.teamId, selector } },
      );
    }
    return match?.id;
  }

  /** Keeps a quiet session out of Linear's 30-minute stale state with an ephemeral thought. */
  armKeepalive(target: LinearSessionTarget): void {
    this.disarmKeepalive(target.sessionId);
    const timer = (this.options.setTimeout ?? globalThis.setTimeout)(() => {
      this.options.state.keepalives.delete(target.sessionId);
      void this.keepalive(target);
    }, LINEAR_KEEPALIVE_MS);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    this.options.state.keepalives.set(target.sessionId, timer);
  }

  disarmKeepalive(sessionId: string): void {
    const timer = this.options.state.keepalives.get(sessionId);
    if (timer === undefined) return;
    (this.options.clearTimeout ?? globalThis.clearTimeout)(timer);
    this.options.state.keepalives.delete(sessionId);
  }

  private async keepalive(target: LinearSessionTarget): Promise<void> {
    const record = await this.options.database.findLinearAgentSession(target.sessionId);
    if (
      record === undefined ||
      record.currentExecutionId === null ||
      record.mirrorStatus !== "active"
    ) {
      return;
    }
    await this.emit(target, {
      ...ephemeralThought(LINEAR_COPY.stillWorking),
      coalesceKey: "keepalive",
    });
  }

  private async upsert(
    event: NormalizedLinearAgentSessionEvent,
    input: { connectionId: string; organizationId: string },
  ): Promise<{ record: LinearAgentSessionRecord; created: boolean }> {
    const issue = event.session.issue;
    if (issue === null) throw new Error("Linear agent session has no issue");
    return this.options.database.upsertLinearAgentSession({
      organizationId: input.organizationId,
      linearConnectionId: input.connectionId,
      linearOrganizationId: event.organizationId,
      linearSessionId: event.session.id,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      teamId: issue.teamId,
    });
  }

  private async queuePrompt(
    record: LinearAgentSessionRecord,
    activity: NonNullable<NormalizedLinearAgentSessionEvent["activity"]>,
  ): Promise<void> {
    await this.options.database.appendLinearPendingPrompt(record.linearSessionId, {
      activityId: activity.id,
      body: activity.body,
      receivedAt: this.now().toISOString(),
    });
    void this.emit(targetOf(record), ephemeralThought(LINEAR_COPY.followUpQueued));
  }

  private async steer(
    record: LinearAgentSessionRecord,
    executionId: string,
    activity: NonNullable<NormalizedLinearAgentSessionEvent["activity"]>,
  ): Promise<void> {
    const target = targetOf(record);
    let outcome: Awaited<ReturnType<ExecutionControl["steer"]>>;
    try {
      outcome = await this.options.control.steer(executionId, activity.id, activity.body);
    } catch (error) {
      await this.queuePrompt(record, activity);
      void this.emit(target, {
        kind: "activity",
        content: { type: "thought", body: LINEAR_COPY.followUpUndeliverable },
        ephemeral: false,
      });
      throw error;
    }
    if (outcome === "sent") {
      void this.emit(target, ephemeralThought(LINEAR_COPY.followUpDelivered));
      return;
    }
    await this.queuePrompt(record, activity);
  }

  private async answerPermission(
    record: LinearAgentSessionRecord,
    pending: LinearPendingPermission,
    body: string,
  ): Promise<void> {
    const target = targetOf(record);
    const answer = body.trim().toLowerCase();
    const option =
      pending.options.find((candidate) => candidate.value.toLowerCase() === answer) ??
      pending.options.find((candidate) => candidate.label.toLowerCase() === answer);
    const response = permissionResponse(option, pending, body.trim());
    const outcome = await this.options.control.respondToPermission(
      pending.executionId,
      pending.requestId,
      response,
    );
    if (outcome === "resolved") return;
    if (outcome === "unconfirmed") {
      reportFailure(
        new Error("permission answer unconfirmed"),
        { component: "triggers", operation: "linear.permission.unconfirmed", provider: "linear" },
        { diagnostic: { sessionId: record.linearSessionId } },
      );
      void this.emit(target, {
        kind: "activity",
        content: { type: "thought", body: LINEAR_COPY.permissionUnconfirmed },
        ephemeral: false,
      });
      return;
    }
    if (outcome === "permission_missing") {
      void this.emit(target, {
        kind: "activity",
        content: {
          type: "thought",
          body: LINEAR_COPY.permissionWaitingWithoutAuthority(pending.requestId),
        },
        ephemeral: false,
      });
      return;
    }
    await this.options.database.updateLinearAgentSession(record.linearSessionId, {
      pendingPermission: null,
    });
    if (outcome === "not_live") return;
    void this.emit(target, {
      kind: "activity",
      content: { type: "error", body: LINEAR_COPY.permissionRefused(outcome.error) },
      ephemeral: false,
    });
  }

  private queueFor(target: LinearSessionTarget): LinearActivityQueue {
    const existing = this.options.state.queues.get(target.sessionId);
    if (existing !== undefined) return existing;
    const queue = new LinearActivityQueue({
      sessionId: target.sessionId,
      linearOrganizationId: target.linearOrganizationId,
      client: () => this.options.state.client,
      silenced: async () => {
        const record = await this.options.database.findLinearAgentSession(target.sessionId);
        return record !== undefined && record.respondedAt !== null;
      },
      onSent: (item, activityId) => this.recordSent(target, item, activityId),
      ...(this.options.setTimeout === undefined ? {} : { setTimeout: this.options.setTimeout }),
    });
    this.options.state.queues.set(target.sessionId, queue);
    return queue;
  }

  private async recordSent(
    target: LinearSessionTarget,
    item: LinearOutboundActivity,
    activityId: string | undefined,
  ): Promise<void> {
    if (item.kind !== "activity") return;
    const now = this.now();
    const type = item.content.type;
    await this.options.database.updateLinearAgentSession(target.sessionId, {
      lastActivityId: activityId ?? item.id ?? null,
      lastActivityAt: now,
      ...terminalPatch(type, now),
      ...(item.priority === "ack" ? { mirrorStatus: "active" as const } : {}),
    });
    if (type === "thought" || type === "action") this.armKeepalive(target);
    else this.disarmKeepalive(target.sessionId);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private report(error: unknown, operation: string, record?: LinearAgentSessionRecord): void {
    reportFailure(
      error,
      { component: "triggers", operation, provider: "linear" },
      record === undefined ? {} : { diagnostic: { sessionId: record.linearSessionId } },
    );
  }
}

/** A terminal activity ends the turn in Linear; the record mirrors the resulting session state. */
function terminalPatch(type: LinearActivityContent["type"], now: Date): LinearAgentSessionPatch {
  if (type === "response") return { respondedAt: now, mirrorStatus: "complete" };
  if (type === "error") return { respondedAt: now, mirrorStatus: "error" };
  if (type === "elicitation") return { respondedAt: now, mirrorStatus: "awaitingInput" };
  return {};
}

function permissionResponse(
  option: LinearPendingPermission["options"][number] | undefined,
  pending: LinearPendingPermission,
  body: string,
): AgentPermissionResponse {
  if (option === undefined) return { behavior: "deny", message: body };
  const selected =
    option.selectedActionId === undefined ? {} : { selectedActionId: option.selectedActionId };
  if (option.behavior === "deny")
    return { behavior: "deny", ...selected, message: "Denied from Linear" };
  if (option.forSession === true) {
    return { behavior: "allow", updatedPermissions: [...pending.suggestions] };
  }
  return { behavior: "allow", ...selected };
}

export function targetOf(record: LinearAgentSessionRecord): LinearSessionTarget {
  return { sessionId: record.linearSessionId, linearOrganizationId: record.linearOrganizationId };
}

export function ephemeralThought(body: string): LinearOutboundActivity {
  return {
    kind: "activity",
    content: { type: "thought", body },
    ephemeral: true,
    coalesceKey: "thought",
  };
}

/** `AgentSessionUpdateInput.summary`: one line, 1-255 code points, no NUL; undefined when blank. */
export function normalizeLinearSummary(value: string): string | undefined {
  const collapsed = value
    .replace(/[\r\n]+/gu, " ")
    .replaceAll("\u0000", " ")
    .trim();
  if (collapsed.length === 0) return undefined;
  return Array.from(collapsed).slice(0, 255).join("");
}

export function isGitHubPullRequestUrl(url: string): boolean {
  return GITHUB_PULL_REQUEST_URL.test(url);
}

function isLiveStatus(status: string): boolean {
  return status === "spawning" || status === "running";
}
