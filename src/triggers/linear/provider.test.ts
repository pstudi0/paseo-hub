import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type {
  LinearAgentSessionActivity,
  LinearAgentSessionActivityHistory,
  LinearApiClient,
  LinearIssueCommentHistory,
  LinearIssueDetails,
} from "../../providers/linear/client.js";
import { createMemoryDatabase } from "../../db/memory.js";
import {
  LINEAR_FIXTURE,
  readLinearFixture,
  type LinearFixtureName,
} from "../../test-utils/linear-fixtures.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import { isAcceptedTriggerProviderMatch, type ExternalTrigger } from "../index.js";
import {
  normalizeLinearEvent,
  type NormalizedLinearAgentSessionEvent,
  type NormalizedLinearCommentEvent,
} from "./events.js";
import {
  createLinearTriggerProvider,
  type LinearMaterializedContext,
  type LinearMaterializedSessionEvent,
} from "./provider.js";

describe("Linear trigger provider", () => {
  it.each([
    ["pattern", { pattern: "/run" }, "/run priority=high investigate"],
    ["contains", { contains: "/run" }, "please /run priority=high investigate"],
  ] as const)(
    "parses inputs after a matched Linear %s marker while preserving the original comment prompt",
    async (_filterName, marker, body) => {
      const { project, revision, store } = await activeConfiguration(commandConfiguration(marker));
      const provider = createLinearTriggerProvider({ configurationStoreForProject: () => store });

      const match = (await provider.match(external(project.id, revision.id, undefined, body)))[0];
      if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

      assert.deepEqual(match.invocation, {
        status: "accepted",
        prompt: body,
        inputs: { priority: "high" },
      });
    },
  );

  it("keeps an input-shaped contains marker available to parsing and input filters", async () => {
    const { project, revision, store } = await activeConfiguration(
      inputShapedMarkerConfiguration(),
    );
    const provider = createLinearTriggerProvider({ configurationStoreForProject: () => store });
    const body = "please repo=hub priority=high investigate";

    const match = (await provider.match(external(project.id, revision.id, undefined, body)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    assert.deepEqual(match.invocation, {
      status: "accepted",
      prompt: body,
      inputs: { repo: "hub", priority: "high" },
    });
  });

  it("parses after a contains command marker following a matched pattern", async () => {
    const { project, revision, store } = await activeConfiguration(
      commandConfiguration({ pattern: "@paseo", contains: "/run" }),
    );
    const provider = createLinearTriggerProvider({ configurationStoreForProject: () => store });
    const body = "@paseo please /run priority=high investigate";

    const match = (await provider.match(external(project.id, revision.id, undefined, body)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    assert.deepEqual(match.invocation, {
      status: "accepted",
      prompt: body,
      inputs: { priority: "high" },
    });
  });

  it("keeps an input-shaped contains marker after a matched pattern", async () => {
    const { project, revision, store } = await activeConfiguration(
      inputShapedMarkerConfiguration({ pattern: "@paseo" }),
    );
    const provider = createLinearTriggerProvider({ configurationStoreForProject: () => store });
    const body = "@paseo please repo=hub priority=high investigate";

    const match = (await provider.match(external(project.id, revision.id, undefined, body)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    assert.deepEqual(match.invocation, {
      status: "accepted",
      prompt: body,
      inputs: { repo: "hub", priority: "high" },
    });
  });

  it("keeps an input-shaped suffix of an overlapping contains marker", async () => {
    const { project, revision, store } = await activeConfiguration(
      inputShapedMarkerConfiguration({ pattern: "@paseo", contains: "@paseo repo=hub" }),
    );
    const provider = createLinearTriggerProvider({ configurationStoreForProject: () => store });
    const body = "@paseo repo=hub priority=high investigate";

    const match = (await provider.match(external(project.id, revision.id, undefined, body)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    assert.deepEqual(match.invocation, {
      status: "accepted",
      prompt: body,
      inputs: { repo: "hub", priority: "high" },
    });
  });

  it("retains a leading input-shaped pattern when stripping a later command marker", async () => {
    const { project, revision, store } = await activeConfiguration(
      inputShapedMarkerConfiguration({ pattern: "repo=hub", contains: "/run" }),
    );
    const provider = createLinearTriggerProvider({ configurationStoreForProject: () => store });
    const body = "repo=hub /run priority=high investigate";

    const match = (await provider.match(external(project.id, revision.id, undefined, body)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    assert.deepEqual(match.invocation, {
      status: "accepted",
      prompt: body,
      inputs: { repo: "hub", priority: "high" },
    });
  });

  it("does not treat an inside-word contains match as a command marker", async () => {
    const { project, revision, store } = await activeConfiguration(
      commandConfiguration({ contains: "run" }),
    );
    const provider = createLinearTriggerProvider({ configurationStoreForProject: () => store });
    const body = "please prerun priority=high investigate";

    const matches = await provider.match(external(project.id, revision.id, undefined, body));
    if (typeof matches === "string") throw new Error("expected invocation rejection");
    const match = matches[0];
    if (match === undefined || match.invocation.status !== "rejected") {
      throw new Error("expected rejected match");
    }

    assert.equal(match.invocation.prompt, body);
    assert.deepEqual(match.invocation.inputs, {});
    assert.deepEqual(match.invocation.rejection, {
      code: "missing_required",
      inputName: "priority",
    });
  });

  it("uses the first boundary-delimited contains marker after prose", async () => {
    const { project, revision, store } = await activeConfiguration(
      commandConfiguration({ contains: "run" }),
    );
    const provider = createLinearTriggerProvider({ configurationStoreForProject: () => store });
    const body = "please prerun run priority=high investigate";

    const match = (await provider.match(external(project.id, revision.id, undefined, body)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    assert.deepEqual(match.invocation, {
      status: "accepted",
      prompt: body,
      inputs: { priority: "high" },
    });
  });

  it("defers a bounded, causal issue history until context materialization", async () => {
    const { project, revision, store } = await activeConfiguration();
    const triggerAt = "2026-01-02T00:00:00.000Z";
    const beforeTrigger = Array.from({ length: 55 }, (_, index) => ({
      id: `comment-${index + 1}`,
      body: `earlier-${index + 1}`,
      createdAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 60_000).toISOString(),
      author: { id: `user-${index + 1}` },
    }));
    const client = new RecordingHistoryClient({
      complete: true,
      comments: [
        { id: "later-comment", body: "later", createdAt: "2026-01-03T00:00:00.000Z", author: null },
        { id: "trigger-comment", body: "trigger", createdAt: triggerAt, author: null },
        ...beforeTrigger.toReversed(),
      ],
    });
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
    });

    const match = (await provider.match(external(project.id, revision.id, triggerAt)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    assert.deepEqual(client.historyReads, []);
    assert.deepEqual(match.triggerContext.event.linear.trigger_thread_context, {
      status: "deferred",
      issue: { id: "issue-1" },
      before: { created_at: triggerAt },
    });

    const context = await provider.materializeContext!({
      executionId: "execution-linear-history",
      organizationId: "hub-org",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111119",
      triggerContext: match.triggerContext,
    });

    assert.deepEqual(client.historyReads, [
      {
        linearOrganizationId: "linear-org",
        issueId: "issue-1",
        beforeCreatedAt: triggerAt,
      },
    ]);
    assert.equal(context.linear.thread.status, "incomplete");
    assert.equal(context.linear.thread.messages.length, 50);
    assert.deepEqual(context.linear.thread.messages[0], {
      id: "issue-1",
      content: "Ship the feature\n\nUseful context",
      author: null,
      created_at: null,
    });
    assert.equal(context.linear.thread.messages[1]?.id, "comment-7");
    assert.equal(context.linear.thread.messages.at(-1)?.id, "comment-55");
    assert.equal(
      context.linear.thread.messages.some(
        (message) => message.id === "trigger-comment" || message.id === "later-comment",
      ),
      false,
    );
  });

  it("keeps a valid Linear run usable when optional history retrieval fails", async () => {
    const { project, revision, store } = await activeConfiguration();
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client: new RecordingHistoryClient(undefined, new Error("Linear history unavailable")),
    });
    const match = (await provider.match(external(project.id, revision.id)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    const context = await provider.materializeContext!({
      executionId: "execution-linear-unavailable",
      organizationId: "hub-org",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111120",
      triggerContext: match.triggerContext,
    });

    assert.deepEqual(context.linear.thread, {
      status: "unavailable",
      messages: [
        {
          id: "issue-1",
          content: "Ship the feature\n\nUseful context",
          author: null,
          created_at: null,
        },
      ],
    });
  });

  it("does not fetch history without a causal event timestamp", async () => {
    const { project, revision, store } = await activeConfiguration();
    const client = new RecordingHistoryClient({ complete: true, comments: [] });
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
    });
    const { occurredAt: _occurredAt, ...payload } = event("2026-01-02T00:00:00.000Z");
    const match = (
      await provider.match({
        ...external(project.id, revision.id),
        payload,
      })
    )[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    const context = await provider.materializeContext!({
      executionId: "execution-linear-no-anchor",
      organizationId: "hub-org",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111121",
      triggerContext: match.triggerContext,
    });

    assert.deepEqual(client.historyReads, []);
    assert.equal(context.linear.thread.status, "unavailable");
    assert.equal(context.linear.thread.messages.length, 1);
  });
});

describe("Linear agent session trigger provider", () => {
  const SESSION_URL = `https://linear.app/lab/issue/LAB-42/fix-the-flaky-daemon-reconnect-test#agentSession-${LINEAR_FIXTURE.sessionId}`;

  it("builds the complete session context, conversation and target for a new session", async () => {
    const { project, revision, store } = await activeConfiguration(linearSessionConfiguration());
    const client = new RecordingSessionClient();
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
    });
    const delivery = {
      ...session("linear-agent-session-created"),
      transportDeliveryId: "delivery-created-1",
    };

    const matches = await provider.match(sessionExternal(project.id, revision.id, delivery));
    if (typeof matches === "string") throw new Error(`unexpected drop: ${matches}`);
    const match = matches[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    assert.equal(matches.length, 1);
    assert.equal(match.triggerName, "delegated");
    assert.deepEqual(client.reads, []);
    assert.deepEqual(match.outputContext, {
      provider: "linear",
      linearOrganizationId: LINEAR_FIXTURE.organizationId,
      issueId: LINEAR_FIXTURE.issueId,
      teamId: LINEAR_FIXTURE.teamId,
      sessionId: LINEAR_FIXTURE.sessionId,
    });
    assert.deepEqual(match.conversation, {
      key: `linear:session:${LINEAR_FIXTURE.sessionId}`,
      label: "Linear session",
      url: SESSION_URL,
      workspaceKey: `linear:issue:${LINEAR_FIXTURE.issueId}`,
    });
    assert.deepEqual(match.invocation, {
      status: "accepted",
      prompt: delivery.promptContext,
      inputs: {},
    });
    assert.deepEqual(match.triggerContext, {
      provider: "linear",
      target: match.outputContext,
      event: {
        linear: {
          event_type: "agent_session",
          action: "created",
          delivery_id: `linear-agent-session:${LINEAR_FIXTURE.sessionId}`,
          transport_delivery_id: "delivery-created-1",
          connection_id: "linear-connection",
          organization: { id: LINEAR_FIXTURE.organizationId },
          app_user: { id: LINEAR_FIXTURE.appUserId },
          actor: { id: LINEAR_FIXTURE.humanId, name: "Anthony" },
          source: "delegation",
          session: {
            id: LINEAR_FIXTURE.sessionId,
            status: "pending",
            url: SESSION_URL,
            created_at: "2026-09-15T10:00:00.000Z",
          },
          issue: {
            id: LINEAR_FIXTURE.issueId,
            identifier: "LAB-42",
            title: "Fix the flaky daemon reconnect test",
            description: "The reconnect test fails once every ~20 runs on CI.",
            url: "https://linear.app/lab/issue/LAB-42/fix-the-flaky-daemon-reconnect-test",
            project: null,
            state: null,
            assignee: null,
            label_ids: [],
          },
          team: { id: LINEAR_FIXTURE.teamId, key: "LAB", name: "Lab" },
          comment: {
            id: LINEAR_FIXTURE.rootCommentId,
            body: "",
            user_id: LINEAR_FIXTURE.appUserId,
          },
          source_comment_id: null,
          creator: { id: LINEAR_FIXTURE.humanId, name: "Anthony" },
          prompt_context: delivery.promptContext,
          guidance: [
            { body: "Prefer small pull requests.", origin: "organization" },
            {
              body: "Run the daemon test suite before opening a pull request.",
              origin: "team",
              team: { id: LINEAR_FIXTURE.teamId, key: "LAB", name: "Lab" },
            },
          ],
          previous_comments: [],
          activity: null,
          authority: {
            onStart: { kind: "type", type: "started" },
            delegate: true,
            mirror: { actions: true, thoughts: "summary", plan: true, permissions: true },
          },
          trigger_thread_context: {
            status: "deferred",
            session: { id: LINEAR_FIXTURE.sessionId },
            before: { created_at: "2026-09-15T10:00:00.000Z", activity_id: null },
          },
        },
      },
    });
  });

  it("binds a follow-up to its prompt: actor, prompt, causal bound and no authority", async () => {
    const { project, revision, store } = await activeConfiguration(linearSessionConfiguration());
    const provider = createLinearTriggerProvider({ configurationStoreForProject: () => store });
    const delivery = session("linear-agent-session-prompted");

    const matches = await provider.match(sessionExternal(project.id, revision.id, delivery));
    if (typeof matches === "string") throw new Error(`unexpected drop: ${matches}`);
    const match = matches[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    const linear = match.triggerContext.event.linear;
    if (linear.event_type !== "agent_session") throw new Error("expected a session context");

    assert.equal(match.triggerName, "followed-up");
    assert.equal(match.invocation.prompt, "Also add a regression test, priority=high");
    assert.equal(linear.delivery_id, `linear-agent-activity:${LINEAR_FIXTURE.promptActivityId}`);
    assert.equal(Object.hasOwn(linear, "transport_delivery_id"), false);
    assert.deepEqual(linear.actor, { id: LINEAR_FIXTURE.humanId, name: "Anthony" });
    assert.deepEqual(linear.activity, {
      id: LINEAR_FIXTURE.promptActivityId,
      body: "Also add a regression test, priority=high",
      created_at: "2026-09-15T10:20:00.000Z",
      signal: null,
      signal_metadata: null,
      source_comment_id: null,
      user: { id: LINEAR_FIXTURE.humanId, name: "Anthony" },
    });
    assert.equal(linear.authority, null);
    assert.equal(linear.prompt_context, null);
    assert.deepEqual(linear.trigger_thread_context, {
      status: "deferred",
      session: { id: LINEAR_FIXTURE.sessionId },
      before: {
        created_at: "2026-09-15T10:20:00.000Z",
        activity_id: LINEAR_FIXTURE.promptActivityId,
      },
    });
    assert.deepEqual(match.conversation, {
      key: `linear:session:${LINEAR_FIXTURE.sessionId}`,
      label: "Linear session",
      url: SESSION_URL,
      workspaceKey: `linear:issue:${LINEAR_FIXTURE.issueId}`,
    });
  });

  it("keeps the signal and its metadata on a stop prompt", async () => {
    const { project, revision, store } = await activeConfiguration(linearSessionConfiguration());
    const provider = createLinearTriggerProvider({ configurationStoreForProject: () => store });
    const delivery = session("linear-agent-session-stop");

    const matches = await provider.match(
      sessionExternal(project.id, revision.id, {
        ...delivery,
        activity: { ...delivery.activity!, signalMetadata: { reason: "manual" } },
      }),
    );
    if (typeof matches === "string") throw new Error(`unexpected drop: ${matches}`);
    const linear = matches[0]!.triggerContext.event.linear;
    if (linear.event_type !== "agent_session") throw new Error("expected a session context");

    assert.equal(linear.activity?.signal, "stop");
    assert.deepEqual(linear.activity?.signal_metadata, { reason: "manual" });
  });

  it("falls back to the issue text when a new session has no prompt context", async () => {
    const { project, revision, store } = await activeConfiguration(linearSessionConfiguration());
    const provider = createLinearTriggerProvider({ configurationStoreForProject: () => store });
    const delivery = { ...session("linear-agent-session-created"), promptContext: null };

    const matches = await provider.match(sessionExternal(project.id, revision.id, delivery));
    if (typeof matches === "string") throw new Error(`unexpected drop: ${matches}`);

    assert.equal(
      matches[0]!.invocation.prompt,
      "Fix the flaky daemon reconnect test\n\nThe reconnect test fails once every ~20 runs on CI.",
    );
  });

  it("parses inputs from the follow-up body and the mention comment, never the prompt context", async () => {
    const { project, revision, store } = await activeConfiguration(sessionInputConfiguration());
    const provider = createLinearTriggerProvider({ configurationStoreForProject: () => store });

    const prompted = session("linear-agent-session-prompted");
    const promptedMatch = (
      await provider.match(
        sessionExternal(project.id, revision.id, {
          ...prompted,
          activity: { ...prompted.activity!, body: "priority=high add a regression test" },
        }),
      )
    )[0];
    if (!isAcceptedTriggerProviderMatch(promptedMatch)) throw new Error("expected accepted match");
    assert.deepEqual(promptedMatch.invocation, {
      status: "accepted",
      prompt: "priority=high add a regression test",
      inputs: { priority: "high" },
    });

    const mention = session("linear-agent-session-created-mention");
    const mentionMatch = (
      await provider.match(
        sessionExternal(project.id, revision.id, {
          ...mention,
          session: {
            ...mention.session,
            comment: { ...mention.session.comment!, body: "priority=low @Paseo take this" },
          },
        }),
      )
    )[0];
    if (!isAcceptedTriggerProviderMatch(mentionMatch)) throw new Error("expected accepted match");
    assert.deepEqual(mentionMatch.invocation, {
      status: "accepted",
      prompt: mention.promptContext,
      inputs: { priority: "low" },
    });

    const delegation = session("linear-agent-session-created");
    const delegationMatches = await provider.match(
      sessionExternal(project.id, revision.id, {
        ...delegation,
        promptContext: 'priority=high <issue identifier="LAB-42"/>',
      }),
    );
    if (typeof delegationMatches === "string") throw new Error("expected a rejected match");
    const delegationMatch = delegationMatches[0];
    if (delegationMatch?.invocation.status !== "rejected") throw new Error("expected rejection");
    assert.deepEqual(delegationMatch.invocation.rejection, {
      code: "missing_required",
      inputName: "priority",
    });
    assert.equal(delegationMatch.invocation.prompt, 'priority=high <issue identifier="LAB-42"/>');
  });

  it("drops a session source that no session trigger serves", async () => {
    const { project, revision, store } = await activeConfiguration();
    const provider = createLinearTriggerProvider({ configurationStoreForProject: () => store });

    assert.equal(
      await provider.match(
        sessionExternal(project.id, revision.id, session("linear-agent-session-created")),
      ),
      "no_trigger_for_source",
    );
  });

  it("reconstructs a bounded, causal session conversation for a follow-up", async () => {
    const { project, revision, store } = await activeConfiguration(linearSessionConfiguration());
    const delivery = session("linear-agent-session-prompted");
    const triggerAt = delivery.activity!.createdAt;
    const earlier = Array.from({ length: 55 }, (_, index) =>
      activity(`activity-${index + 1}`, index % 2 === 0 ? "prompt" : "response", {
        body: `turn-${index + 1}`,
        createdAt: new Date(Date.parse("2026-09-15T10:01:00.000Z") + index * 10_000).toISOString(),
      }),
    );
    const client = new RecordingSessionClient({
      activities: {
        complete: true,
        activities: [
          activity("later", "prompt", { body: "later", createdAt: "2026-09-15T10:30:00.000Z" }),
          activity(LINEAR_FIXTURE.promptActivityId, "prompt", {
            body: delivery.activity!.body,
            createdAt: triggerAt,
          }),
          activity("mirror-thought", "thought", { createdAt: "2026-09-15T10:05:05.000Z" }),
          activity("mirror-action", "action", { createdAt: "2026-09-15T10:05:06.000Z" }),
          ...earlier.toReversed(),
        ],
      },
      issue: hydratedIssue(),
    });
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
    });
    const match = (await provider.match(sessionExternal(project.id, revision.id, delivery)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    assert.deepEqual(client.reads, []);

    const context = await provider.materializeContext!({
      executionId: "execution-linear-session-history",
      organizationId: "hub-org",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111130",
      triggerContext: match.triggerContext,
    });
    const linear = sessionContext(context.linear);

    assert.deepEqual(client.reads, [
      {
        method: "readAgentSessionActivities",
        input: {
          linearOrganizationId: LINEAR_FIXTURE.organizationId,
          agentSessionId: LINEAR_FIXTURE.sessionId,
          beforeCreatedAt: triggerAt,
        },
      },
      {
        method: "readIssue",
        input: {
          linearOrganizationId: LINEAR_FIXTURE.organizationId,
          issueId: LINEAR_FIXTURE.issueId,
        },
      },
    ]);
    assert.equal(linear.thread.status, "incomplete");
    assert.equal(linear.thread.messages.length, 49);
    assert.deepEqual(linear.thread.messages[0], {
      id: "activity-7",
      content: "turn-7",
      author: { id: "user-activity-7" },
      created_at: "2026-09-15T10:02:00.000Z",
      kind: "prompt",
    });
    assert.equal(linear.thread.messages.at(-1)?.kind, "prompt");
    assert.equal(linear.thread.messages.at(-1)?.id, "activity-55");
    assert.equal(
      linear.thread.messages.some((message) =>
        ["later", LINEAR_FIXTURE.promptActivityId, "mirror-thought", "mirror-action"].includes(
          message.id,
        ),
      ),
      false,
    );
    assert.deepEqual(linear.issue, {
      id: LINEAR_FIXTURE.issueId,
      identifier: "LAB-42",
      title: "Fix the flaky daemon reconnect test",
      description: "The reconnect test fails once every ~20 runs on CI.",
      url: "https://linear.app/lab/issue/LAB-42/fix-the-flaky-daemon-reconnect-test",
      branch_name: "anthony/lab-42-fix-the-flaky-daemon-reconnect-test",
      project: { id: "project-1" },
      state: { id: "state-started", name: "In Progress", type: "started" },
      assignee: { id: LINEAR_FIXTURE.humanId },
      label_ids: ["label-flaky"],
      delegate: { id: LINEAR_FIXTURE.appUserId },
    });
    assert.equal(Object.hasOwn(linear, "trigger_thread_context"), false);
    assert.equal(linear.activity?.id, LINEAR_FIXTURE.promptActivityId);
  });

  it("reports a complete conversation as available, excluding only the trigger prompt", async () => {
    const { project, revision, store } = await activeConfiguration(linearSessionConfiguration());
    const delivery = session("linear-agent-session-prompted");
    const client = new RecordingSessionClient({
      activities: {
        complete: true,
        activities: [
          activity("first", "prompt", { body: "Fix it", createdAt: "2026-09-15T10:00:10.000Z" }),
          activity("answer", "response", { body: "Done", createdAt: "2026-09-15T10:10:00.000Z" }),
          activity("question", "elicitation", {
            body: "Which branch?",
            createdAt: "2026-09-15T10:11:00.000Z",
          }),
          activity("failure", "error", { body: "Oops", createdAt: "2026-09-15T10:12:00.000Z" }),
          activity(LINEAR_FIXTURE.promptActivityId, "prompt", {
            body: delivery.activity!.body,
            createdAt: delivery.activity!.createdAt,
          }),
        ],
      },
    });
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
    });
    const match = (await provider.match(sessionExternal(project.id, revision.id, delivery)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    const context = await provider.materializeContext!({
      executionId: "execution-linear-session-complete",
      organizationId: "hub-org",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111131",
      triggerContext: match.triggerContext,
    });
    const linear = sessionContext(context.linear);

    assert.equal(linear.thread.status, "available");
    assert.deepEqual(
      linear.thread.messages.map((message) => [message.id, message.kind]),
      [
        ["first", "prompt"],
        ["answer", "response"],
        ["question", "elicitation"],
        ["failure", "error"],
      ],
    );
    // `readIssue` found nothing: the issue stays as the session delivered it.
    assert.deepEqual(
      client.reads.map((read) => read.method),
      ["readAgentSessionActivities", "readIssue"],
    );
    assert.equal(linear.issue.project, null);
    assert.equal(Object.hasOwn(linear.issue, "branch_name"), false);
  });

  it("gives a new session an empty, available history without reading activities", async () => {
    const { project, revision, store } = await activeConfiguration(linearSessionConfiguration());
    const client = new RecordingSessionClient({ issue: hydratedIssue() });
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client,
    });
    const match = (
      await provider.match(
        sessionExternal(project.id, revision.id, session("linear-agent-session-created")),
      )
    )[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    const context = await provider.materializeContext!({
      executionId: "execution-linear-session-created",
      organizationId: "hub-org",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111132",
      triggerContext: match.triggerContext,
    });
    const linear = sessionContext(context.linear);

    assert.deepEqual(linear.thread, { status: "available", messages: [] });
    assert.deepEqual(
      client.reads.map((read) => read.method),
      ["readIssue"],
    );
    assert.equal(linear.issue.branch_name, "anthony/lab-42-fix-the-flaky-daemon-reconnect-test");
    assert.deepEqual(linear.issue.state, {
      id: "state-started",
      name: "In Progress",
      type: "started",
    });
  });

  it("keeps a session run usable when history or issue hydration fails", async () => {
    const { project, revision, store } = await activeConfiguration(linearSessionConfiguration());
    const failing = new RecordingSessionClient(undefined, new Error("Linear unavailable"));
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => store,
      client: failing,
    });
    const match = (
      await provider.match(
        sessionExternal(project.id, revision.id, session("linear-agent-session-prompted")),
      )
    )[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    const context = await provider.materializeContext!({
      executionId: "execution-linear-session-unavailable",
      organizationId: "hub-org",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111133",
      triggerContext: match.triggerContext,
    });
    const linear = sessionContext(context.linear);

    assert.deepEqual(linear.thread, { status: "unavailable", messages: [] });
    assert.equal(linear.issue.project, null);
    assert.equal(linear.session.id, LINEAR_FIXTURE.sessionId);
  });

  it("leaves a follow-up's history unavailable without a client able to read activities", async () => {
    const { project, revision, store } = await activeConfiguration(linearSessionConfiguration());
    for (const client of [
      undefined,
      new RecordingHistoryClient({ complete: true, comments: [] }),
    ]) {
      const provider = createLinearTriggerProvider({
        configurationStoreForProject: () => store,
        ...(client === undefined ? {} : { client }),
      });
      const match = (
        await provider.match(
          sessionExternal(project.id, revision.id, session("linear-agent-session-prompted")),
        )
      )[0];
      if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

      const context = await provider.materializeContext!({
        executionId: "execution-linear-session-no-client",
        organizationId: "hub-org",
        projectId: project.id,
        providerEventReceiptId: "11111111-1111-4111-8111-111111111134",
        triggerContext: match.triggerContext,
      });

      assert.deepEqual(sessionContext(context.linear).thread, {
        status: "unavailable",
        messages: [],
      });
    }
  });
});

class RecordingSessionClient implements Partial<
  Pick<LinearApiClient, "readAgentSessionActivities" | "readIssue">
> {
  reads: Array<{ method: "readAgentSessionActivities" | "readIssue"; input: unknown }> = [];

  constructor(
    private readonly responses:
      | { activities?: LinearAgentSessionActivityHistory; issue?: LinearIssueDetails }
      | undefined = {},
    private readonly error?: Error,
  ) {}

  readAgentSessionActivities(input: {
    linearOrganizationId: string;
    agentSessionId: string;
    beforeCreatedAt: string;
  }): Promise<LinearAgentSessionActivityHistory> {
    this.reads.push({ method: "readAgentSessionActivities", input });
    if (this.error !== undefined) return Promise.reject(this.error);
    if (this.responses?.activities === undefined) {
      return Promise.reject(new Error("activities were not configured"));
    }
    return Promise.resolve(this.responses.activities);
  }

  readIssue(input: {
    linearOrganizationId: string;
    issueId: string;
  }): Promise<LinearIssueDetails | undefined> {
    this.reads.push({ method: "readIssue", input });
    if (this.error !== undefined) return Promise.reject(this.error);
    return Promise.resolve(this.responses?.issue);
  }
}

function activity(
  id: string,
  type: LinearAgentSessionActivity["content"]["type"],
  input: { body?: string; createdAt: string },
): LinearAgentSessionActivity {
  return {
    id,
    createdAt: input.createdAt,
    signal: null,
    user: { id: `user-${id}` },
    content: type === "thought" || type === "action" ? { type } : { type, body: input.body ?? "" },
  };
}

function hydratedIssue(): LinearIssueDetails {
  return {
    id: LINEAR_FIXTURE.issueId,
    identifier: "LAB-42",
    title: "Fix the flaky daemon reconnect test",
    description: "The reconnect test fails once every ~20 runs on CI.",
    url: "https://linear.app/lab/issue/LAB-42/fix-the-flaky-daemon-reconnect-test",
    branchName: "anthony/lab-42-fix-the-flaky-daemon-reconnect-test",
    teamId: LINEAR_FIXTURE.teamId,
    team: { id: LINEAR_FIXTURE.teamId, key: "LAB", name: "Lab" },
    projectId: "project-1",
    stateId: "state-started",
    state: { id: "state-started", name: "In Progress", type: "started" },
    assigneeId: LINEAR_FIXTURE.humanId,
    delegateId: LINEAR_FIXTURE.appUserId,
    labelIds: ["label-flaky"],
  };
}

function sessionContext(
  linear: LinearMaterializedContext["linear"],
): LinearMaterializedSessionEvent {
  if (linear.event_type !== "agent_session") throw new Error("expected a session context");
  return linear;
}

function session(fixture: LinearFixtureName): NormalizedLinearAgentSessionEvent {
  const normalized = normalizeLinearEvent(readLinearFixture(fixture));
  if (normalized?.type !== "agent_session") {
    throw new Error(`expected a session fixture: ${fixture}`);
  }
  return normalized;
}

function sessionExternal(
  projectId: string,
  configurationRevisionId: string,
  delivery: NormalizedLinearAgentSessionEvent,
): ExternalTrigger {
  return {
    providerEventReceiptId: "11111111-1111-4111-8111-111111111130",
    organizationId: "hub-org",
    projectId,
    configurationRevisionId,
    source: "linear.agent_session",
    deliveryId:
      delivery.activity === null
        ? `linear-agent-session:${delivery.session.id}`
        : `linear-agent-activity:${delivery.activity.id}`,
    receivedAt: new Date(delivery.occurredAt),
    connectionId: "linear-connection",
    resourceId: delivery.session.issue?.teamId ?? null,
    payload: delivery,
  };
}

function linearSessionConfiguration() {
  const step = {
    id: "work",
    environment: "runner",
    max_runtime: "1h",
    idle_timeout: "5m",
    agent: { provider: "codex" },
    prompt: [{ text: "Work from ${{ paseo.context }}" }],
  };
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "delegated",
        on: "linear.agent_session_created",
        max_runtime: "1h",
        filters: { team: LINEAR_FIXTURE.teamId, from_users: [LINEAR_FIXTURE.humanId] },
        steps: [{ ...step, linear: { on_start: "started", delegate: true } }],
      },
      {
        name: "followed-up",
        on: "linear.agent_session_prompted",
        max_runtime: "1h",
        filters: { team: LINEAR_FIXTURE.teamId, from_users: ["*"] },
        steps: [step],
      },
    ],
  };
}

function sessionInputConfiguration() {
  const configuration = linearSessionConfiguration();
  return {
    ...configuration,
    triggers: configuration.triggers.map((trigger) =>
      Object.assign({}, trigger, {
        inputs: { priority: { type: "string", required: true, choices: ["high", "low"] } },
      }),
    ),
  };
}

class RecordingHistoryClient implements Pick<LinearApiClient, "readIssueComments"> {
  historyReads: Array<{
    linearOrganizationId: string;
    issueId: string;
    beforeCreatedAt: string;
  }> = [];

  constructor(
    private readonly history: LinearIssueCommentHistory | undefined,
    private readonly error?: Error,
  ) {}

  readIssueComments(input: (typeof this.historyReads)[number]): Promise<LinearIssueCommentHistory> {
    this.historyReads.push(input);
    if (this.error !== undefined) return Promise.reject(this.error);
    if (this.history === undefined) return Promise.reject(new Error("history was not configured"));
    return Promise.resolve(this.history);
  }
}

function activeConfiguration(configuration: unknown = linearCommentConfiguration()) {
  return createActiveProjectConfiguration(createMemoryDatabase(), configuration, {
    organizationId: "hub-org",
  });
}

function linearCommentConfiguration() {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "comment",
        on: "linear.comment_created",
        max_runtime: "1h",
        filters: { project: "project-1", from_users: ["operator"] },
        steps: [
          {
            id: "work",
            environment: "runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "codex" },
            prompt: [{ text: "Work from ${{ paseo.context }}" }],
          },
        ],
      },
    ],
  };
}

function commandConfiguration(marker: { pattern?: string; contains?: string }) {
  const configuration = linearCommentConfiguration();
  const trigger = configuration.triggers[0]!;
  return {
    ...configuration,
    triggers: [
      {
        ...trigger,
        inputs: {
          priority: { type: "string", required: true, choices: ["high", "low"] },
        },
        filters: {
          ...trigger.filters,
          ...marker,
          inputs: { priority: "high" },
        },
      },
    ],
  };
}

function inputShapedMarkerConfiguration(marker: { pattern?: string; contains?: string } = {}) {
  const configuration = linearCommentConfiguration();
  const trigger = configuration.triggers[0]!;
  return {
    ...configuration,
    triggers: [
      {
        ...trigger,
        inputs: {
          repo: { type: "string", required: true, choices: ["hub", "paseo"] },
          priority: { type: "string", required: true, choices: ["high", "low"] },
        },
        filters: {
          ...trigger.filters,
          contains: "repo=hub",
          ...marker,
          inputs: { repo: "hub" },
        },
      },
    ],
  };
}

function external(
  projectId: string,
  configurationRevisionId: string,
  occurredAt = "2026-01-02T00:00:00.000Z",
  commentBody = "@paseo please investigate",
): ExternalTrigger {
  return {
    providerEventReceiptId: "11111111-1111-4111-8111-111111111119",
    organizationId: "hub-org",
    projectId,
    configurationRevisionId,
    source: "linear.comment",
    deliveryId: "delivery-1",
    receivedAt: new Date(occurredAt),
    connectionId: "linear-connection",
    payload: event(occurredAt, commentBody),
  };
}

function event(
  occurredAt: string,
  commentBody = "@paseo please investigate",
): NormalizedLinearCommentEvent {
  return {
    type: "comment",
    action: "create",
    id: "trigger-comment",
    organizationId: "linear-org",
    actor: { id: "operator" },
    comment: { id: "trigger-comment", issueId: "issue-1", body: commentBody },
    issue: {
      id: "issue-1",
      identifier: "ENG-42",
      title: "Ship the feature",
      description: "Useful context",
      projectId: "project-1",
      stateId: "ready",
      assigneeId: null,
      labelIds: [],
    },
    occurredAt,
  };
}
