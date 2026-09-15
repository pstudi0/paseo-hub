import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  fixtureRecord,
  LINEAR_FIXTURE,
  readLinearFixture,
} from "../../test-utils/linear-fixtures.js";
import {
  eventIssueId,
  eventRouteResourceId,
  linearSessionSource,
  normalizeLinearEvent,
  readLinearEventFamily,
} from "./events.js";

describe("Linear event normalization", () => {
  it("uses a comment's own timestamp as the causal history anchor", () => {
    const event = normalizeLinearEvent({
      action: "create",
      type: "Comment",
      organizationId: "linear-org",
      createdAt: "2026-01-02T00:00:05.000Z",
      webhookTimestamp: Date.parse("2026-01-02T00:00:10.000Z"),
      data: {
        id: "comment-1",
        issueId: "issue-1",
        body: "Please investigate",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    });

    assert.equal(event?.occurredAt, "2026-01-02T00:00:00.000Z");
  });

  it("does not use a delivery timestamp as a causal history anchor", () => {
    const event = normalizeLinearEvent({
      action: "create",
      type: "Comment",
      organizationId: "linear-org",
      webhookTimestamp: Date.parse("2026-01-02T00:00:10.000Z"),
      data: { id: "comment-1", issueId: "issue-1", body: "Please investigate" },
    });

    assert.equal(event?.occurredAt, undefined);
  });

  it("falls back to a nested comment user when the top-level actor is null", () => {
    const event = normalizeComment({ user: { id: "user-1", displayName: "Operator" } });

    assert.deepEqual(event?.actor, { id: "user-1", name: "Operator" });
  });

  it("falls back to a nested comment user ID when the top-level actor is null", () => {
    const event = normalizeComment({ userId: "user-1" });

    assert.deepEqual(event?.actor, { id: "user-1" });
  });

  it("preserves explicit nulls in relation-expanded previous issue values", () => {
    const event = normalizeLinearEvent({
      action: "update",
      type: "Issue",
      organizationId: "linear-org",
      updatedFrom: { project: null, state: null, assignee: null },
      data: {
        id: "issue-1",
        title: "Newly scoped issue",
        description: null,
        project: { id: "project-1" },
        state: { id: "state-1" },
        assignee: { id: "user-1" },
      },
    });

    assert.equal(event?.type, "issue");
    if (event?.type !== "issue") throw new Error("expected an issue event");
    assert.deepEqual(event.updatedFrom, {
      projectId: null,
      stateId: null,
      assigneeId: null,
    });
  });

  it("does not replace explicit null issue relations with hydrated values", () => {
    const event = normalizeLinearEvent(
      {
        action: "update",
        type: "Issue",
        organizationId: "linear-org",
        data: {
          id: "issue-1",
          title: "Projectless issue",
          project: null,
          state: null,
          assignee: null,
        },
      },
      undefined,
      {
        id: "issue-1",
        title: "Projectless issue",
        description: null,
        projectId: "later-project",
        stateId: "later-state",
        assigneeId: "later-assignee",
        labelIds: [],
      },
    );

    assert.equal(event?.type, "issue");
    if (event?.type !== "issue") throw new Error("expected an issue event");
    assert.deepEqual(
      {
        projectId: event.issue.projectId,
        stateId: event.issue.stateId,
        assigneeId: event.issue.assigneeId,
      },
      { projectId: null, stateId: null, assigneeId: null },
    );
  });
});

describe("Linear agent session normalization", () => {
  it("normalizes a delegated session with every unset relation as null", () => {
    const event = normalizeLinearEvent(readLinearFixture("linear-agent-session-created"));

    assert.deepEqual(event, {
      type: "agent_session",
      action: "created",
      id: LINEAR_FIXTURE.sessionId,
      organizationId: LINEAR_FIXTURE.organizationId,
      appUserId: LINEAR_FIXTURE.appUserId,
      oauthClientId: LINEAR_FIXTURE.oauthClientId,
      session: {
        id: LINEAR_FIXTURE.sessionId,
        status: "pending",
        url: `https://linear.app/lab/issue/LAB-42/fix-the-flaky-daemon-reconnect-test#agentSession-${LINEAR_FIXTURE.sessionId}`,
        createdAt: "2026-09-15T10:00:00.000Z",
        commentId: LINEAR_FIXTURE.rootCommentId,
        sourceCommentId: null,
        creator: {
          id: LINEAR_FIXTURE.humanId,
          name: "Anthony",
          email: "anthony@example.com",
          url: "https://linear.app/lab/profiles/anthony",
        },
        issue: {
          id: LINEAR_FIXTURE.issueId,
          identifier: "LAB-42",
          title: "Fix the flaky daemon reconnect test",
          description: "The reconnect test fails once every ~20 runs on CI.",
          url: "https://linear.app/lab/issue/LAB-42/fix-the-flaky-daemon-reconnect-test",
          teamId: LINEAR_FIXTURE.teamId,
          team: { id: LINEAR_FIXTURE.teamId, key: "LAB", name: "Lab" },
        },
        comment: { id: LINEAR_FIXTURE.rootCommentId, body: "", userId: LINEAR_FIXTURE.appUserId },
      },
      promptContext: readLinearFixture("linear-agent-session-created")["promptContext"],
      guidance: [
        { body: "Prefer small pull requests.", origin: { type: "Organization" } },
        {
          body: "Run the daemon test suite before opening a pull request.",
          origin: {
            type: "Team",
            team: { id: LINEAR_FIXTURE.teamId, key: "LAB", name: "Lab" },
          },
        },
      ],
      previousComments: [],
      activity: null,
      occurredAt: "2026-09-15T10:00:00.250Z",
    });
  });

  it("normalizes an automation session whose unset keys are absent rather than null", () => {
    const payload = readLinearFixture("linear-agent-session-created-automation");
    const session = fixtureRecord(payload["agentSession"]);
    for (const key of ["creator", "creatorId", "comment", "commentId", "sourceCommentId", "url"]) {
      assert.equal(Object.hasOwn(session, key), false, `${key} must be absent`);
    }
    assert.equal(Object.hasOwn(payload, "guidance"), false);
    assert.equal(Object.hasOwn(payload, "previousComments"), false);

    const event = normalizeLinearEvent(payload);
    if (event?.type !== "agent_session") throw new Error("expected a session event");

    assert.deepEqual(
      {
        creator: event.session.creator,
        comment: event.session.comment,
        commentId: event.session.commentId,
        sourceCommentId: event.session.sourceCommentId,
        url: event.session.url,
        guidance: event.guidance,
        previousComments: event.previousComments,
      },
      {
        creator: null,
        comment: null,
        commentId: null,
        sourceCommentId: null,
        url: null,
        guidance: [],
        previousComments: [],
      },
    );
  });

  it("normalizes a follow-up prompt under the activity's own identity and timestamp", () => {
    const payload = readLinearFixture("linear-agent-session-prompted");
    const activity = fixtureRecord(payload["agentActivity"]);
    for (const key of ["signal", "signalMetadata", "sourceCommentId"]) {
      assert.equal(Object.hasOwn(activity, key), false, `${key} must be absent`);
    }

    const event = normalizeLinearEvent(payload, "AgentSessionEvent");
    if (event?.type !== "agent_session") throw new Error("expected a session event");

    assert.equal(event.action, "prompted");
    assert.equal(event.id, LINEAR_FIXTURE.promptActivityId);
    assert.equal(event.promptContext, null);
    assert.deepEqual(event.activity, {
      id: LINEAR_FIXTURE.promptActivityId,
      body: "Also add a regression test, priority=high",
      createdAt: "2026-09-15T10:20:00.000Z",
      signal: null,
      signalMetadata: null,
      sourceCommentId: null,
      user: {
        id: LINEAR_FIXTURE.humanId,
        name: "Anthony",
        email: "anthony@example.com",
        url: "https://linear.app/lab/profiles/anthony",
      },
    });
  });

  it("normalizes a stop signal as a prompt carrying the signal", () => {
    const event = normalizeLinearEvent(readLinearFixture("linear-agent-session-stop"));
    if (event?.type !== "agent_session") throw new Error("expected a session event");

    assert.equal(event.id, LINEAR_FIXTURE.stopActivityId);
    assert.equal(event.activity?.signal, "stop");
    assert.equal(event.activity?.body, "Stop");
  });

  it("anchors the event on the envelope's createdAt, never the signed delivery timestamp", () => {
    const payload = readLinearFixture("linear-agent-session-created");
    payload["webhookTimestamp"] = Date.parse("2026-09-15T10:00:09.000Z");

    const event = normalizeLinearEvent(payload);

    assert.equal(event?.occurredAt, "2026-09-15T10:00:00.250Z");
  });

  it("ignores a prompted event whose activity is not a prompt", () => {
    const payload = readLinearFixture("linear-agent-session-prompted");
    fixtureRecord(payload["agentActivity"])["content"] = {
      type: "thought",
      body: "Thinking",
    };

    assert.equal(normalizeLinearEvent(payload), undefined);
  });

  it("ignores a prompted event without an activity", () => {
    const payload = readLinearFixture("linear-agent-session-prompted");
    delete payload["agentActivity"];

    assert.equal(normalizeLinearEvent(payload), undefined);
  });

  it("keeps a session without an issue but gives it no route and no issue", () => {
    const payload = readLinearFixture("linear-agent-session-created");
    delete fixtureRecord(payload["agentSession"])["issue"];
    delete fixtureRecord(payload["agentSession"])["issueId"];

    const event = normalizeLinearEvent(payload);
    if (event?.type !== "agent_session") throw new Error("expected a session event");

    assert.equal(event.session.issue, null);
    assert.equal(eventRouteResourceId(event), undefined);
    assert.throws(() => eventIssueId(event), /Linear session has no issue/u);
  });

  it("routes a session by its issue's team and exposes the issue id", () => {
    const event = normalizeLinearEvent(readLinearFixture("linear-agent-session-created"));
    if (event === undefined) throw new Error("expected an event");

    assert.equal(eventRouteResourceId(event), LINEAR_FIXTURE.teamId);
    assert.equal(eventIssueId(event), LINEAR_FIXTURE.issueId);
  });

  it("keeps routing issue events by project", () => {
    const event = normalizeLinearEvent({
      action: "create",
      type: "Issue",
      organizationId: "linear-org",
      data: { id: "issue-1", title: "Scoped", description: null, projectId: "project-1" },
    });
    if (event === undefined) throw new Error("expected an event");

    assert.equal(eventRouteResourceId(event), "project-1");
  });

  it.each([
    ["linear-agent-session-created", "delegation"],
    ["linear-agent-session-created-mention", "mention"],
    ["linear-agent-session-created-automation", "automation"],
    ["linear-agent-session-prompted", "delegation"],
  ] as const)("derives the session source of %s as %s", (fixture, source) => {
    const event = normalizeLinearEvent(readLinearFixture(fixture));
    if (event?.type !== "agent_session") throw new Error("expected a session event");

    assert.equal(linearSessionSource(event), source);
  });

  it("does not read an artificial root comment as a mention", () => {
    const event = normalizeLinearEvent(readLinearFixture("linear-agent-session-created"));
    if (event?.type !== "agent_session") throw new Error("expected a session event");

    assert.notEqual(event.session.comment, null);
    assert.equal(linearSessionSource(event), "delegation");
    assert.equal(
      linearSessionSource({
        ...event,
        session: {
          ...event.session,
          comment: { id: "c", body: "@Paseo look", userId: LINEAR_FIXTURE.humanId },
        },
      }),
      "mention",
    );
    assert.equal(
      linearSessionSource({ ...event, session: { ...event.session, sourceCommentId: "c" } }),
      "mention",
    );
    assert.equal(
      linearSessionSource({ ...event, session: { ...event.session, creator: null } }),
      "automation",
    );
  });

  it("recognizes agent sessions by exact type and entity webhooks by substring", () => {
    assert.equal(readLinearEventFamily("AgentSessionEvent", undefined), "agent_session");
    assert.equal(readLinearEventFamily(null, "AgentSessionEvent"), "agent_session");
    assert.equal(readLinearEventFamily(null, "agentsessionevent"), undefined);
    assert.equal(readLinearEventFamily("Comment", undefined), "comment");
    assert.equal(readLinearEventFamily(null, "Issue"), "issue");
    assert.equal(readLinearEventFamily("PermissionChange", undefined), undefined);
  });

  it("does not normalize lifecycle deliveries as trigger events", () => {
    for (const fixture of [
      "linear-permission-change",
      "linear-oauth-app-revoked",
      "linear-app-user-notification-unassigned",
    ] as const) {
      assert.equal(normalizeLinearEvent(readLinearFixture(fixture)), undefined);
    }
  });
});

function normalizeComment(extraData: Record<string, unknown>) {
  const event = normalizeLinearEvent({
    action: "create",
    type: "Comment",
    organizationId: "linear-org",
    actor: null,
    data: {
      id: "comment-1",
      issueId: "issue-1",
      body: "Please investigate",
      ...extraData,
    },
  });
  if (event?.type !== "comment") throw new Error("expected a comment event");
  return event;
}
