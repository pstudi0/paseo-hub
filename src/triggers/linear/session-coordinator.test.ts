import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { ExecutionControl } from "../../daemons/execution-control.js";
import type { LinearLifecycleEvent } from "./lifecycle-events.js";
import type {
  AgentExecutionRecord,
  LinearAgentSessionPatch,
  LinearAgentSessionRecord,
  LinearLifecycleReceiptClaim,
  LinearPendingPrompt,
  UpsertLinearAgentSessionInput,
} from "../../db/types.js";
import type { LinearApiClient, LinearIssueDetails } from "../../providers/linear/client.js";
import {
  fixtureRecord,
  LINEAR_FIXTURE,
  readLinearFixture,
} from "../../test-utils/linear-fixtures.js";
import { deriveLinearActivityId } from "./activity-id.js";
import { createLinearAgentOutputExecutors } from "./agent-outputs.js";
import { LINEAR_COPY } from "./copy.js";
import { normalizeLinearEvent, type NormalizedLinearAgentSessionEvent } from "./events.js";
import { HubExecutionAgentStreamEventSchema } from "../../hub/protocol.js";
import { createLinearMirror, describeToolCall } from "./mirror.js";
import type { LinearOutputContext, LinearTriggerContext } from "./provider.js";
import {
  LinearSessionCoordinator,
  normalizeLinearSummary,
  type LinearSessionCoordinatorDatabase,
  type LinearSessionCoordinatorTimer,
} from "./session-coordinator.js";
import { createLinearSessionState } from "./session-state.js";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "00000000-0000-4000-8000-000000000002";

describe("Linear activity ids", () => {
  it("derives a stable UUID v4 from a seed", () => {
    const id = deriveLinearActivityId("session:ack");
    assert.equal(id, deriveLinearActivityId("session:ack"));
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u);
    assert.notEqual(id, deriveLinearActivityId("session:started"));
  });

  it("normalizes a session summary to one bounded line", () => {
    assert.equal(
      normalizeLinearSummary(`  POS-1
fix${String.fromCharCode(0)}it  `),
      "POS-1 fix it",
    );
    assert.equal(normalizeLinearSummary(" \n "), undefined);
    assert.equal(normalizeLinearSummary("x".repeat(300))?.length, 255);
  });
});

describe("Linear session coordinator", () => {
  it("acknowledges a created session with a thought first, then the link and summary", async () => {
    const world = createWorld();
    await world.coordinator.acknowledge(createdEvent(), {
      connectionId: CONNECTION_ID,
      organizationId: ORGANIZATION_ID,
    });
    await world.client.settled();
    assert.deepEqual(
      world.client.calls.map((call) => call.method),
      ["createAgentActivity", "updateAgentSession", "updateAgentSession"],
    );
    const ack = world.client.calls[0];
    assert.equal(field(ack, "id"), deriveLinearActivityId(`${LINEAR_FIXTURE.sessionId}:ack`));
    assert.equal(field(ack, "content", "body"), LINEAR_COPY.ack);
    assert.deepEqual(field(world.client.calls[1], "addedExternalUrls"), [
      { label: "Paseo Hub", url: "https://hub.test/o/acme/activity" },
    ]);
    const record = await world.database.findLinearAgentSession(LINEAR_FIXTURE.sessionId);
    assert.equal(record?.mirrorStatus, "active");
    assert.equal(record?.issueId, LINEAR_FIXTURE.issueId);
  });

  it("steers a live execution on a follow-up and starts a new run after a response", async () => {
    const world = createWorld();
    await world.coordinator.acknowledge(createdEvent(), {
      connectionId: CONNECTION_ID,
      organizationId: ORGANIZATION_ID,
    });
    world.executions.set("exec-1", execution("exec-1", "running", "agent-1"));
    await world.database.updateLinearAgentSession(LINEAR_FIXTURE.sessionId, {
      currentExecutionId: "exec-1",
      daemonAgentId: "agent-1",
    });

    assert.equal(await world.coordinator.followUp(promptedEvent(), sessionInput()), "steered");
    await world.client.settled();
    assert.deepEqual(world.control.steers, [
      { executionId: "exec-1", messageId: LINEAR_FIXTURE.promptActivityId, text: "Add tests" },
    ]);

    await world.database.updateLinearAgentSession(LINEAR_FIXTURE.sessionId, {
      respondedAt: new Date(),
    });
    assert.equal(await world.coordinator.followUp(promptedEvent(), sessionInput()), "dispatch");
  });

  it("answers in the commented thread instead of taking the thread over", async () => {
    const world = createWorld();
    await world.coordinator.acknowledge(createdEvent(), sessionInput());
    world.executions.set("exec-1", execution("exec-1", "running", "agent-1"));
    await world.database.updateLinearAgentSession(LINEAR_FIXTURE.sessionId, {
      currentExecutionId: "exec-1",
      daemonAgentId: "agent-1",
    });
    world.client.threadRoot = LINEAR_FIXTURE.mentionCommentId;

    const prompted = promptedEvent("Add tests", LINEAR_FIXTURE.previousCommentId);
    assert.equal(await world.coordinator.followUp(prompted, sessionInput()), "steered");
    // The thread gets an ordinary reply straight away; no session is attached to it.
    assert.deepEqual(
      world.client.calls.filter((call) => call.method === "createAgentSessionOnIssue"),
      [],
    );
    assert.deepEqual(
      world.client.calls
        .filter((call) => call.method === "createComment")
        .map((call) => ({ parentId: field(call, "parentId"), body: field(call, "body") })),
      [{ parentId: LINEAR_FIXTURE.mentionCommentId, body: LINEAR_COPY.workingInThread }],
    );

    // The session's answer rewrites that same comment rather than adding another one.
    await world.coordinator.answerThreadReply(
      LINEAR_FIXTURE.sessionId,
      LINEAR_FIXTURE.organizationId,
      "Tests ajoutés.",
    );
    assert.deepEqual(
      world.client.calls
        .filter((call) => call.method === "updateComment")
        .map((call) => field(call, "body")),
      ["Tests ajoutés."],
    );
  });

  it("queues a follow-up while the agent is still spawning", async () => {
    const world = createWorld();
    await world.coordinator.acknowledge(createdEvent(), sessionInput());
    world.executions.set("exec-1", execution("exec-1", "spawning", null));
    await world.database.updateLinearAgentSession(LINEAR_FIXTURE.sessionId, {
      currentExecutionId: "exec-1",
    });
    assert.equal(await world.coordinator.followUp(promptedEvent(), sessionInput()), "queued");
    assert.deepEqual(
      (await world.database.takeLinearPendingPrompts(LINEAR_FIXTURE.sessionId)).map(
        (prompt) => prompt.body,
      ),
      ["Add tests"],
    );
    assert.equal(world.control.steers.length, 0);
  });

  it("interrupts the live execution on stop and answers when nothing runs", async () => {
    const world = createWorld();
    await world.coordinator.acknowledge(createdEvent(), sessionInput());
    world.executions.set("exec-1", execution("exec-1", "running", "agent-1"));
    await world.database.updateLinearAgentSession(LINEAR_FIXTURE.sessionId, {
      currentExecutionId: "exec-1",
    });
    assert.equal(await world.coordinator.followUp(stopEvent(), sessionInput()), "stopped");
    await world.client.settled();
    assert.deepEqual(world.control.interrupts, [
      { executionId: "exec-1", reason: "linear_stop_requested" },
    ]);
    const record = await world.database.findLinearAgentSession(LINEAR_FIXTURE.sessionId);
    assert.notEqual(record?.stopRequestedAt, null);

    world.executions.set("exec-1", execution("exec-1", "succeeded", "agent-1"));
    await world.coordinator.followUp(stopEvent(), sessionInput());
    await world.client.settled();
    assert.deepEqual(field(world.client.calls.at(-1), "content"), {
      type: "response",
      body: LINEAR_COPY.nothingRunning,
    });
  });
});

describe("Linear thread replies without a mention", () => {
  it("routes a reply in its own thread into the issue's existing session", async () => {
    const world = createWorld();
    world.client.threadAuthors = [LINEAR_FIXTURE.appUserId, LINEAR_FIXTURE.humanId];
    await world.coordinator.acknowledge(createdEvent(), sessionInput());
    const prompt = await world.coordinator.applyLifecycle(
      newCommentNotification(LINEAR_FIXTURE.rootCommentId),
      claim(),
    );
    assert.equal(prompt?.action, "prompted");
    assert.equal(prompt?.session.id, LINEAR_FIXTURE.sessionId);
    assert.equal(prompt?.activity?.body, "Et la suite ?");
    // No new session: the message joins the work already under way on this issue.
    assert.deepEqual(
      world.client.calls.filter((call) => call.method === "createAgentSessionOnIssue"),
      [],
    );
  });

  it("stays out of a thread it never wrote in, and out of its own replies", async () => {
    const world = createWorld();
    await world.coordinator.acknowledge(createdEvent(), sessionInput());

    world.client.threadAuthors = [LINEAR_FIXTURE.humanId, LINEAR_FIXTURE.otherHumanId];
    const foreign = await world.coordinator.applyLifecycle(
      newCommentNotification(LINEAR_FIXTURE.rootCommentId),
      claim(),
    );

    world.client.threadAuthors = [LINEAR_FIXTURE.appUserId];
    const own = await world.coordinator.applyLifecycle(
      newCommentNotification(LINEAR_FIXTURE.rootCommentId, LINEAR_FIXTURE.appUserId),
      claim(),
    );

    // A root comment carries no thread to join.
    const root = await world.coordinator.applyLifecycle(newCommentNotification(null), claim());

    assert.deepEqual([foreign, own, root], [undefined, undefined, undefined]);
  });
});

describe("Linear agent outputs", () => {
  it("posts the response with the attempt id and marks the session complete", async () => {
    const world = createWorld();
    await world.coordinator.acknowledge(createdEvent(), sessionInput());
    const outputs = createLinearAgentOutputExecutors({
      coordinator: world.coordinator,
      database: world.database,
    });
    await outputs.response({
      agentExecutionId: "exec-1",
      attemptId: "9b2f6e2a-2b4e-4d1e-8c3a-1f2e3d4c5b6a",
      toolType: "linear.response",
      args: { content: "Done: PR opened." },
      outputContext: outputContext(),
    });
    const call = world.client.calls.at(-1);
    assert.equal(field(call, "id"), "9b2f6e2a-2b4e-4d1e-8c3a-1f2e3d4c5b6a");
    assert.deepEqual(field(call, "content"), { type: "response", body: "Done: PR opened." });
    assert.equal(field(call, "ephemeral"), false);
    const record = await world.database.findLinearAgentSession(LINEAR_FIXTURE.sessionId);
    assert.equal(record?.mirrorStatus, "complete");
    assert.notEqual(record?.respondedAt, null);
  });

  it("asks with select options and links a pull request through the issue", async () => {
    const world = createWorld();
    await world.coordinator.acknowledge(createdEvent(), sessionInput());
    await world.client.settled();
    const outputs = createLinearAgentOutputExecutors({
      coordinator: world.coordinator,
      database: world.database,
    });
    await outputs.ask({
      agentExecutionId: "exec-1",
      toolType: "linear.ask",
      args: { content: "Deploy now?", options: [{ label: "Yes", value: "yes" }] },
      outputContext: outputContext(),
    });
    const ask = world.client.calls.at(-1);
    assert.equal(field(ask, "content", "type"), "elicitation");
    assert.equal(field(ask, "signal"), "select");
    assert.deepEqual(field(ask, "signalMetadata"), { options: [{ label: "Yes", value: "yes" }] });

    await outputs.link({
      agentExecutionId: "exec-1",
      toolType: "linear.link",
      args: { label: "PR #7", url: "https://github.com/acme/repo/pull/7" },
      outputContext: outputContext(),
    });
    assert.deepEqual(
      world.client.calls.slice(-2).map((call) => call.method),
      ["updateAgentSession", "linkGitHubPullRequest"],
    );
    const record = await world.database.findLinearAgentSession(LINEAR_FIXTURE.sessionId);
    assert.equal(record?.pullRequestUrl, "https://github.com/acme/repo/pull/7");
  });
});

describe("Linear mirror", () => {
  it("mirrors tool calls as actions and falls back to a response at the end of a turn", async () => {
    const world = createWorld();
    await world.coordinator.acknowledge(createdEvent(), sessionInput());
    await world.client.settled();
    await world.database.updateLinearAgentSession(LINEAR_FIXTURE.sessionId, {
      currentExecutionId: "exec-1",
    });
    const mirror = createLinearMirror({
      coordinator: world.coordinator,
      database: world.database,
      control: world.control,
    });
    const observe = (event: unknown) =>
      mirror.observe({
        executionId: "exec-1",
        agentId: "agent-1",
        daemonId: "daemon-1",
        triggerContext: triggerContext(),
        outputContext: outputContext(),
        event: HubExecutionAgentStreamEventSchema.parse(event),
        observedAt: new Date(),
      });
    await observe({ type: "turn_started", provider: "claude" });
    await observe({
      type: "timeline",
      provider: "claude",
      item: {
        type: "tool_call",
        callId: "call-1",
        name: "Bash",
        status: "running",
        detail: { type: "shell", command: "npm test" },
      },
    });
    // A streaming tool repeats its running item; only the first one reaches Linear.
    await observe({
      type: "timeline",
      provider: "claude",
      item: {
        type: "tool_call",
        callId: "call-1",
        name: "Bash",
        status: "running",
        detail: { type: "shell", command: "npm test" },
      },
    });
    await observe({
      type: "timeline",
      provider: "claude",
      item: { type: "assistant_message", text: "Tests pass; wrapping up." },
    });
    await observe({ type: "turn_completed", provider: "claude" });
    await world.client.settled();
    const activities = world.client.calls
      .filter((call) => call.method === "createAgentActivity")
      .map((call) => field(call, "content"));
    assert.deepEqual(activities.at(-3), {
      type: "action",
      action: "Running",
      parameter: "npm test",
    });
    // A tool call the daemon did not describe still reads as plain words, never "Bash Bash".
    assert.deepEqual(describeToolCall({ name: "Bash" }), {
      verb: "Running",
      parameter: "a command",
    });
    assert.deepEqual(describeToolCall({ name: "mcp__x__WebFetch" }), {
      verb: "Reading",
      parameter: "a web page",
    });
    assert.deepEqual(
      describeToolCall({
        name: "Bash",
        detail: { type: "shell", command: "git log --oneline -25 && ls docs" },
      }),
      { verb: "Running", parameter: "git log" },
    );
    assert.deepEqual(activities.at(-2), { type: "thought", body: "Tests pass; wrapping up." });
    assert.deepEqual(activities.at(-1), { type: "response", body: "Tests pass; wrapping up." });
  });

  it("stays silent after linear_ask and turns a permission into an elicitation", async () => {
    const world = createWorld();
    await world.coordinator.acknowledge(createdEvent(), sessionInput());
    await world.client.settled();
    await world.database.updateLinearAgentSession(LINEAR_FIXTURE.sessionId, {
      currentExecutionId: "exec-1",
    });
    const outputs = createLinearAgentOutputExecutors({
      coordinator: world.coordinator,
      database: world.database,
    });
    const mirror = createLinearMirror({
      coordinator: world.coordinator,
      database: world.database,
      control: world.control,
    });
    const observe = (event: unknown) =>
      mirror.observe({
        executionId: "exec-1",
        agentId: "agent-1",
        daemonId: "daemon-1",
        triggerContext: triggerContext(),
        outputContext: outputContext(),
        event: HubExecutionAgentStreamEventSchema.parse(event),
        observedAt: new Date(),
      });
    await observe({ type: "turn_started", provider: "claude" });
    await outputs.ask({
      agentExecutionId: "exec-1",
      toolType: "linear.ask",
      args: { content: "Which database?" },
      outputContext: outputContext(),
    });
    const before = world.client.calls.length;
    await observe({ type: "turn_completed", provider: "claude" });
    await world.client.settled();
    assert.equal(world.client.calls.length, before);

    await observe({ type: "turn_started", provider: "claude" });
    world.control.permissions = ["hub.execute", "workspace.write"];
    await observe({
      type: "permission_requested",
      provider: "claude",
      request: { id: "perm-1", name: "Bash", kind: "tool", title: "Run rm -rf build" },
    });
    await world.client.settled();
    const elicitation = world.client.calls.at(-1);
    assert.equal(field(elicitation, "content", "type"), "elicitation");
    assert.equal(field(elicitation, "signal"), "select");
    assert.deepEqual(field(elicitation, "signalMetadata"), {
      options: [
        { label: "Allow", value: "allow" },
        { label: "Deny", value: "deny" },
      ],
    });
    const record = await world.database.findLinearAgentSession(LINEAR_FIXTURE.sessionId);
    assert.equal(record?.pendingPermission?.requestId, "perm-1");

    assert.equal(
      await world.coordinator.followUp(promptedEvent("Allow"), sessionInput()),
      "answered_permission",
    );
    await world.client.settled();
    assert.deepEqual(world.control.answers, [
      { executionId: "exec-1", requestId: "perm-1", response: { behavior: "allow" } },
    ]);
  });
});

function createWorld() {
  const state = createLinearSessionState();
  const client = new RecordingClient();
  state.client = client.asApiClient();
  const executions = new Map<string, AgentExecutionRecord>();
  const database = new StubDatabase(executions);
  const control = new FakeControl();
  const coordinator = new LinearSessionCoordinator({
    state,
    control,
    database,
    publicBaseUrl: "https://hub.test",
    setTimeout: fakeTimer,
    clearTimeout: () => undefined,
  });
  return { state, client, database, control, coordinator, executions };
}

// Pacing and retry delays fire at once; the 25-minute keepalive never fires in tests.
const unrefTimer = setTimeout(() => undefined, 0);
unrefTimer.unref();
const fakeTimer: LinearSessionCoordinatorTimer = (callback, delay) => {
  if (delay < 60_000) callback();
  return unrefTimer;
};

function newCommentNotification(
  parentCommentId: string | null,
  actorId: string = LINEAR_FIXTURE.humanId,
): Extract<LinearLifecycleEvent, { kind: "notification" }> {
  return {
    kind: "notification",
    type: "AppUserNotification",
    action: "issueNewComment",
    organizationId: LINEAR_FIXTURE.organizationId,
    oauthClientId: LINEAR_FIXTURE.oauthClientId,
    appUserId: LINEAR_FIXTURE.appUserId,
    notification: {
      issueId: LINEAR_FIXTURE.issueId,
      actorId,
      commentId: LINEAR_FIXTURE.previousCommentId,
      parentCommentId,
      comment: {
        id: LINEAR_FIXTURE.previousCommentId,
        body: "Et la suite ?",
        userId: actorId,
      },
    },
    webhookId: LINEAR_FIXTURE.webhookId,
    createdAt: "2026-09-16T10:00:00.000Z",
  };
}

function claim(): Extract<LinearLifecycleReceiptClaim, { status: "claimed" }> {
  return {
    status: "claimed",
    providerEventReceiptId: "receipt-1",
    connectionId: CONNECTION_ID,
    organizationId: ORGANIZATION_ID,
    linearOrganizationId: LINEAR_FIXTURE.organizationId,
  };
}

function sessionInput() {
  return { connectionId: CONNECTION_ID, organizationId: ORGANIZATION_ID };
}

function createdEvent(): NormalizedLinearAgentSessionEvent {
  return sessionEvent(readLinearFixture("linear-agent-session-created"));
}

function promptedEvent(
  body = "Add tests",
  sourceCommentId?: string,
): NormalizedLinearAgentSessionEvent {
  const fixture = readLinearFixture("linear-agent-session-prompted");
  const activity = fixtureRecord(fixture["agentActivity"]);
  activity["body"] = body;
  fixtureRecord(activity["content"])["body"] = body;
  if (sourceCommentId !== undefined) activity["sourceCommentId"] = sourceCommentId;
  return sessionEvent(fixture);
}

function stopEvent(): NormalizedLinearAgentSessionEvent {
  return sessionEvent(readLinearFixture("linear-agent-session-stop"));
}

function sessionEvent(payload: Record<string, unknown>): NormalizedLinearAgentSessionEvent {
  const event = normalizeLinearEvent(payload, "AgentSessionEvent");
  if (event?.type !== "agent_session") throw new Error("fixture is not an agent session");
  return event;
}

function outputContext(): LinearOutputContext {
  return {
    provider: "linear",
    linearOrganizationId: LINEAR_FIXTURE.organizationId,
    issueId: LINEAR_FIXTURE.issueId,
    teamId: LINEAR_FIXTURE.teamId,
    sessionId: LINEAR_FIXTURE.sessionId,
  };
}

function triggerContext(): LinearTriggerContext {
  return {
    provider: "linear",
    target: outputContext(),
    event: {
      linear: {
        event_type: "agent_session",
        action: "created",
        delivery_id: "delivery-1",
        connection_id: CONNECTION_ID,
        organization: { id: LINEAR_FIXTURE.organizationId },
        app_user: { id: LINEAR_FIXTURE.appUserId },
        actor: { id: LINEAR_FIXTURE.humanId },
        source: "delegation",
        session: {
          id: LINEAR_FIXTURE.sessionId,
          status: "pending",
          url: null,
          created_at: "2026-09-15T10:00:00.000Z",
        },
        issue: {
          id: LINEAR_FIXTURE.issueId,
          identifier: "LAB-42",
          title: "Fix it",
          description: null,
          url: "https://linear.app/acme/issue/LAB-42",
          project: null,
          state: null,
          assignee: null,
          label_ids: [],
        },
        team: { id: LINEAR_FIXTURE.teamId, key: "LAB", name: "Lab" },
        comment: null,
        source_comment_id: null,
        creator: { id: LINEAR_FIXTURE.humanId },
        prompt_context: null,
        guidance: [],
        previous_comments: [],
        activity: null,
        authority: null,
        trigger_thread_context: { status: "unavailable" },
      },
    },
  };
}

function execution(
  id: string,
  status: AgentExecutionRecord["status"],
  daemonAgentId: string | null,
): AgentExecutionRecord {
  return {
    id,
    status,
    daemonAgentId,
    daemonId: "daemon-1",
    agentSessionId: "session-1",
    agentSessionAction: null,
    organizationId: ORGANIZATION_ID,
    projectId: "project-1",
    machineId: null,
    startedAt: new Date(),
    completedAt: null,
    completedByAgentAt: null,
    deadlineAt: null,
    idleDeadlineAt: null,
    result: null,
    triggerContext: null,
    outputContext: null,
    reactionState: null,
    configurationRevisionId: "revision-1",
    completionTokenHash: null,
    replyClaimedAt: null,
    replyClaimCount: 0,
    outputEmissions: {},
    outputDeliveryAttempts: {},
    launchIntent: null,
    workflowStepRunId: null,
    hubAction: null,
    hubActionCompletedAt: null,
    hubActionReadyAt: null,
    hubActionAcknowledgements: { terminalAt: null, idleAt: null, finishExecutionCall: null },
  };
}

class RecordingClient {
  calls: { method: string; input: Record<string, unknown> }[] = [];
  /** The thread root `readCommentThreadRoot` reports; tests override it to fork a session. */
  threadRoot: string | undefined = undefined;
  /** Who already wrote in the thread; tests override it to allow or refuse a wake-up. */
  threadAuthors: readonly string[] = [];
  /** The issue a routed thread reply rebuilds its session event from. */
  issue: LinearIssueDetails | undefined = {
    id: LINEAR_FIXTURE.issueId,
    identifier: "LAB-42",
    title: "Fix the flaky daemon reconnect test",
    description: null,
    url: "https://linear.app/acme/issue/LAB-42",
    teamId: LINEAR_FIXTURE.teamId,
    team: { id: LINEAR_FIXTURE.teamId, key: "LAB", name: "Lab" },
    projectId: null,
    stateId: null,
    assigneeId: null,
    labelIds: [],
  };
  private inFlight: Promise<unknown>[] = [];

  /** The methods the coordinator calls; anything else throws when reached. */
  asApiClient(): LinearApiClient {
    const unsupported = () => Promise.reject(new Error("not recorded by this test"));
    const client: LinearApiClient = {
      readIssue: () => Promise.resolve(this.issue),
      readIssueComments: unsupported,
      createComment: (input) => {
        this.calls.push({ method: "createComment", input: asRecord(input) });
        return Promise.resolve({ id: "thread-reply-1" });
      },
      createAgentActivity: (input) => this.createAgentActivity(input),
      updateAgentSession: (input) => this.updateAgentSession(input),
      readAgentSessionActivities: unsupported,
      readCommentThreadRoot: () => Promise.resolve(this.threadRoot),
      readCommentThreadAuthors: () => Promise.resolve(this.threadAuthors),
      createAgentSessionOnIssue: (input) => {
        this.calls.push({ method: "createAgentSessionOnIssue", input: asRecord(input) });
        return Promise.resolve({ id: "session-on-issue" });
      },
      updateComment: (input) => {
        this.calls.push({ method: "updateComment", input: asRecord(input) });
        return Promise.resolve();
      },
      readTeamStates: () => this.readTeamStates(),
      updateIssue: (input) => this.updateIssue(input),
      linkGitHubPullRequest: (input) => this.linkGitHubPullRequest(input),
      linkUrl: (input) => this.linkUrl(input),
    };
    return client;
  }

  async settled(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await Promise.all(this.inFlight);
  }

  createAgentActivity(input: { id?: string }): Promise<{ id: string }> {
    return this.record("createAgentActivity", input, { id: input.id ?? "activity-1" });
  }

  updateAgentSession(input: unknown): Promise<void> {
    return this.record("updateAgentSession", input, undefined);
  }

  linkGitHubPullRequest(input: unknown): Promise<void> {
    return this.record("linkGitHubPullRequest", input, undefined);
  }

  linkUrl(input: unknown): Promise<void> {
    return this.record("linkUrl", input, undefined);
  }

  readTeamStates(): Promise<never[]> {
    return Promise.resolve([]);
  }

  updateIssue(input: unknown): Promise<void> {
    return this.record("updateIssue", input, undefined);
  }

  private record<T>(method: string, input: unknown, result: T): Promise<T> {
    this.calls.push({ method, input: asRecord(input) });
    const promise = Promise.resolve(result);
    this.inFlight.push(promise);
    return promise;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error("expected an object");
  return Object.fromEntries(Object.entries(value));
}

/** Reads a nested field of a recorded call without type assertions. */
function field(call: { input: Record<string, unknown> } | undefined, ...path: string[]): unknown {
  let current: unknown = call?.input;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

class FakeControl implements ExecutionControl {
  steers: { executionId: string; messageId: string; text: string }[] = [];
  interrupts: { executionId: string; reason: string }[] = [];
  answers: { executionId: string; requestId: string; response: unknown }[] = [];
  permissions: string[] = ["hub.execute"];

  steer(executionId: string, messageId: string, text: string) {
    this.steers.push({ executionId, messageId, text });
    return Promise.resolve("sent" as const);
  }

  interrupt(executionId: string, reason: string) {
    this.interrupts.push({ executionId, reason });
    return Promise.resolve(true);
  }

  respondToPermission(executionId: string, requestId: string, response: unknown) {
    this.answers.push({ executionId, requestId, response });
    return Promise.resolve("resolved" as const);
  }

  readWorkspacePullRequest() {
    return Promise.resolve(undefined);
  }

  daemonPermissions() {
    return Promise.resolve(this.permissions);
  }
}

class StubDatabase implements LinearSessionCoordinatorDatabase {
  private readonly records = new Map<string, LinearAgentSessionRecord>();
  private readonly prompts = new Map<string, LinearPendingPrompt[]>();

  constructor(private readonly executions: Map<string, AgentExecutionRecord>) {}

  upsertLinearAgentSession(input: UpsertLinearAgentSessionInput) {
    const existing = this.records.get(input.linearSessionId);
    if (existing !== undefined) return Promise.resolve({ record: existing, created: false });
    const record: LinearAgentSessionRecord = {
      id: `row-${String(this.records.size + 1)}`,
      organizationId: input.organizationId,
      linearConnectionId: input.linearConnectionId,
      linearOrganizationId: input.linearOrganizationId,
      linearSessionId: input.linearSessionId,
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier ?? null,
      teamId: input.teamId,
      projectId: null,
      agentSessionId: null,
      currentExecutionId: null,
      daemonId: null,
      daemonAgentId: null,
      daemonWorkspaceId: null,
      mirrorStatus: "pending",
      respondedAt: null,
      lastActivityId: null,
      lastActivityAt: null,
      lastAssistantMessage: null,
      pullRequestUrl: null,
      pendingPermission: null,
      pendingPrompts: [],
      stopRequestedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.records.set(record.linearSessionId, record);
    return Promise.resolve({ record, created: true });
  }

  findLinearAgentSession(linearSessionId: string) {
    const record = this.records.get(linearSessionId);
    return Promise.resolve(record === undefined ? undefined : { ...record });
  }

  updateLinearAgentSession(linearSessionId: string, patch: LinearAgentSessionPatch) {
    const record = this.records.get(linearSessionId);
    if (record === undefined) return Promise.resolve(undefined);
    const updated = { ...record, ...patch, updatedAt: new Date() } as LinearAgentSessionRecord;
    this.records.set(linearSessionId, updated);
    return Promise.resolve({ ...updated });
  }

  appendLinearPendingPrompt(linearSessionId: string, prompt: LinearPendingPrompt) {
    this.prompts.set(linearSessionId, [...(this.prompts.get(linearSessionId) ?? []), prompt]);
    return this.findLinearAgentSession(linearSessionId);
  }

  takeLinearPendingPrompts(linearSessionId: string) {
    const prompts = this.prompts.get(linearSessionId) ?? [];
    this.prompts.delete(linearSessionId);
    return Promise.resolve(prompts);
  }

  listLinearAgentSessionsForIssue(_linearOrganizationId: string, issueId: string) {
    return Promise.resolve(
      Array.from(this.records.values()).filter((record) => record.issueId === issueId),
    );
  }

  findLinearConnection() {
    return Promise.resolve(undefined);
  }

  applyLinearLifecycle() {
    return Promise.resolve();
  }

  findOrganizationSlug() {
    return Promise.resolve("acme");
  }

  findAgentExecutionById(id: string) {
    return Promise.resolve(this.executions.get(id));
  }
}
