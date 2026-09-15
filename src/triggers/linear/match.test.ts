import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileHubConfig } from "../../config/index.js";
import {
  LINEAR_FIXTURE,
  readLinearFixture,
  type LinearFixtureName,
} from "../../test-utils/linear-fixtures.js";
import {
  normalizeLinearEvent,
  type NormalizedLinearAgentSessionEvent,
  type NormalizedLinearCommentEvent,
  type NormalizedLinearIssueEvent,
} from "./events.js";
import {
  matchesSessionScope,
  matchLinearTriggers,
  readLinearInvocationParserMessage,
} from "./match.js";

describe("Linear trigger matching", () => {
  it("starts a project scout exactly when an issue enters its eligible scope", () => {
    const config = configuration();
    const entered = issue({ action: "update", updatedFrom: { stateId: "backlog" } });
    assert.deepEqual(
      matchLinearTriggers(config, entered).map((match) => match.trigger.name),
      ["scout"],
    );

    const alreadyEligible = issue({ action: "update", updatedFrom: { stateId: "ready" } });
    assert.equal(matchLinearTriggers(config, alreadyEligible).length, 0);

    const irrelevantEdit = issue({ action: "update", updatedFrom: {} });
    assert.equal(matchLinearTriggers(config, irrelevantEdit).length, 0);

    const excluded = issue({ action: "create", labelIds: ["no-paseo"] });
    assert.equal(matchLinearTriggers(config, excluded).length, 0);
  });

  it("keeps assignment and comment triggers actor-allowlisted", () => {
    const config = configuration();
    const assigned = issue({ action: "update", updatedFrom: { assigneeId: null } });
    assert.deepEqual(
      matchLinearTriggers(config, assigned).map((match) => match.trigger.name),
      ["assignment"],
    );
    assert.equal(
      matchLinearTriggers(config, { ...assigned, actor: { id: "untrusted" } }).length,
      0,
    );
    assert.equal(
      matchLinearTriggers(config, {
        ...assigned,
        actor: { id: "untrusted", name: "operator" },
      }).length,
      0,
    );
    assert.equal(
      matchLinearTriggers(config, {
        ...assigned,
        issue: { ...assigned.issue, assigneeId: null },
      }).length,
      0,
    );

    const comment = commentEvent();
    assert.deepEqual(
      matchLinearTriggers(config, comment).map((match) => match.trigger.name),
      ["comment"],
    );
    assert.equal(
      matchLinearTriggers(config, { ...comment, comment: { ...comment.comment, body: "hello" } })
        .length,
      0,
    );
  });

  it("keeps triggers isolated to their configured Linear connection", () => {
    const connectionId = "11111111-1111-4111-8111-111111111111";
    const config = configuration();
    const scopedConfig = Object.assign({}, config, {
      triggers: config.triggers.map((trigger) =>
        Object.assign({}, trigger, {
          filters: Object.assign({}, trigger.filters, { connectionId }),
        }),
      ),
    });

    const events = [
      {
        event: issue({ action: "update", updatedFrom: { stateId: "backlog" } }),
        expected: "scout",
      },
      {
        event: issue({ action: "update", updatedFrom: { assigneeId: null } }),
        expected: "assignment",
      },
      { event: commentEvent(), expected: "comment" },
    ];

    for (const { event, expected } of events) {
      assert.deepEqual(
        matchLinearTriggers(scopedConfig, event, connectionId).map((match) => match.trigger.name),
        [expected],
      );
      assert.equal(
        matchLinearTriggers(scopedConfig, event, "22222222-2222-4222-8222-222222222222").length,
        0,
      );
    }
  });
});

describe("Linear agent session matching", () => {
  it("serves created and prompted sessions from their own events only", () => {
    const config = sessionConfiguration();

    assert.deepEqual(names(matchLinearTriggers(config, session("linear-agent-session-created"))), [
      "delegated",
    ]);
    assert.deepEqual(names(matchLinearTriggers(config, session("linear-agent-session-prompted"))), [
      "followed-up",
    ]);
    assert.deepEqual(names(matchLinearTriggers(config, session("linear-agent-session-stop"))), [
      "followed-up",
    ]);
  });

  it("never matches session events on issue or comment triggers, nor the reverse", () => {
    assert.equal(
      matchLinearTriggers(configuration(), session("linear-agent-session-created")).length,
      0,
    );
    assert.equal(
      matchLinearTriggers(configuration(), session("linear-agent-session-prompted")).length,
      0,
    );
    const sessionOnly = sessionConfiguration();
    assert.equal(matchLinearTriggers(sessionOnly, issue({ action: "create" })).length, 0);
    assert.equal(matchLinearTriggers(sessionOnly, commentEvent()).length, 0);
  });

  it("keeps sessions on the trigger's team", () => {
    const otherTeam = sessionConfiguration({ team: "6f1e7b2a-1b6e-4c47-9d2c-0d0d0d0d0dff" });

    assert.equal(matchLinearTriggers(otherTeam, session("linear-agent-session-created")).length, 0);
    assert.equal(
      matchLinearTriggers(otherTeam, session("linear-agent-session-prompted")).length,
      0,
    );
  });

  it("ignores a session without an issue", () => {
    const event = session("linear-agent-session-created");
    const withoutIssue = { ...event, session: { ...event.session, issue: null } };

    assert.equal(matchLinearTriggers(sessionConfiguration(), withoutIssue).length, 0);
  });

  it.each([
    { source: ["delegation"], fixture: "linear-agent-session-created", matches: true },
    { source: ["delegation"], fixture: "linear-agent-session-created-mention", matches: false },
    { source: ["mention"], fixture: "linear-agent-session-created-mention", matches: true },
    { source: ["mention"], fixture: "linear-agent-session-created", matches: false },
    { source: ["automation"], fixture: "linear-agent-session-created-automation", matches: true },
    { source: ["automation"], fixture: "linear-agent-session-created", matches: false },
    {
      source: ["delegation", "mention"],
      fixture: "linear-agent-session-created-mention",
      matches: true,
    },
  ] as const)("filters by source $source for $fixture", ({ source, fixture, matches }) => {
    const config = sessionConfiguration({ source: [...source], allow_automations: true });

    assert.equal(matchLinearTriggers(config, session(fixture)).length, matches ? 1 : 0);
  });

  it("accepts a session without a responsible human only when automations are allowed", () => {
    const automation = session("linear-agent-session-created-automation");

    assert.equal(matchLinearTriggers(sessionConfiguration(), automation).length, 0);
    assert.deepEqual(
      names(matchLinearTriggers(sessionConfiguration({ allow_automations: true }), automation)),
      ["delegated"],
    );
    // `from_users` is not consulted for an automation: matching does not need the allowlist the
    // compiler still requires on `created`.
    assert.equal(
      matchesSessionScope(automation, { team: LINEAR_FIXTURE.teamId, allow_automations: true }),
      true,
    );
    assert.equal(
      matchesSessionScope(automation, {
        team: LINEAR_FIXTURE.teamId,
        from_users: [LINEAR_FIXTURE.humanId],
      }),
      false,
    );
  });

  it("allowlists the creator of a new session and the author of a follow-up", () => {
    const stranger = { id: LINEAR_FIXTURE.otherHumanId, name: "Camille" };
    const created = session("linear-agent-session-created");
    const prompted = session("linear-agent-session-prompted");
    const config = sessionConfiguration({ from_users: [LINEAR_FIXTURE.humanId] });

    assert.deepEqual(names(matchLinearTriggers(config, created)), ["delegated"]);
    assert.equal(
      matchLinearTriggers(config, {
        ...created,
        session: { ...created.session, creator: stranger },
      }).length,
      0,
    );
    assert.deepEqual(names(matchLinearTriggers(config, prompted)), ["followed-up"]);
    assert.equal(
      matchLinearTriggers(config, {
        ...prompted,
        activity: { ...prompted.activity!, user: stranger },
      }).length,
      0,
    );
    assert.equal(
      matchLinearTriggers(config, {
        ...created,
        session: { ...created.session, creator: null },
      }).length,
      0,
    );
  });

  it("honors the wildcard for follow-ups only", () => {
    const filter = { team: LINEAR_FIXTURE.teamId, from_users: ["*"] };

    assert.equal(matchesSessionScope(session("linear-agent-session-prompted"), filter), true);
    assert.equal(matchesSessionScope(session("linear-agent-session-created"), filter), false);
    assert.equal(
      matchesSessionScope(session("linear-agent-session-created"), {
        ...filter,
        from_users: ["*", LINEAR_FIXTURE.humanId],
      }),
      true,
    );
    assert.equal(
      matchesSessionScope(session("linear-agent-session-prompted"), { ...filter, from_users: [] }),
      false,
    );
    assert.equal(matchesSessionScope(session("linear-agent-session-prompted"), undefined), false);
  });

  it("keeps session triggers isolated to their configured Linear connection", () => {
    const connectionId = "11111111-1111-4111-8111-111111111111";
    const config = sessionConfiguration();
    const scoped = Object.assign({}, config, {
      triggers: config.triggers.map((trigger) =>
        Object.assign({}, trigger, {
          filters: Object.assign({}, trigger.filters, { connectionId }),
        }),
      ),
    });

    for (const [fixture, expected] of [
      ["linear-agent-session-created", "delegated"],
      ["linear-agent-session-prompted", "followed-up"],
    ] as const) {
      assert.deepEqual(names(matchLinearTriggers(scoped, session(fixture), connectionId)), [
        expected,
      ]);
      assert.equal(
        matchLinearTriggers(scoped, session(fixture), "22222222-2222-4222-8222-222222222222")
          .length,
        0,
      );
      assert.equal(matchLinearTriggers(scoped, session(fixture)).length, 0);
    }
  });

  it("hands the parser the follow-up body, the mention comment, or nothing", () => {
    assert.equal(
      readLinearInvocationParserMessage(session("linear-agent-session-prompted"), undefined),
      "Also add a regression test, priority=high",
    );
    assert.equal(
      readLinearInvocationParserMessage(session("linear-agent-session-created-mention"), undefined),
      "@Paseo please take this one, priority=high",
    );
    assert.equal(
      readLinearInvocationParserMessage(session("linear-agent-session-created"), undefined),
      "",
    );
    assert.equal(
      readLinearInvocationParserMessage(
        session("linear-agent-session-created-automation"),
        undefined,
      ),
      "",
    );
    assert.equal(
      readLinearInvocationParserMessage(session("linear-agent-session-prompted"), {
        pattern: "Also",
      }),
      "add a regression test, priority=high",
    );
  });

  it("never parses a root comment Linear wrote as the app user, only a human's", () => {
    const created = session("linear-agent-session-created");
    const rootComment = (userId: string | null) => ({
      ...created,
      session: { ...created.session, comment: { id: "root", body: "priority=high", userId } },
    });

    assert.equal(
      readLinearInvocationParserMessage(rootComment(LINEAR_FIXTURE.appUserId), undefined),
      "",
    );
    assert.equal(readLinearInvocationParserMessage(rootComment(null), undefined), "");
    assert.equal(
      readLinearInvocationParserMessage(rootComment(LINEAR_FIXTURE.humanId), undefined),
      "priority=high",
    );
  });
});

describe("Linear comment invocation parser handoff", () => {
  it.each([
    {
      name: "uses a later contains marker after a consumed pattern",
      filters: { pattern: "@paseo", contains: "/run" },
      body: "@paseo please /run priority=high investigate",
      expected: "priority=high investigate",
    },
    {
      name: "treats equal markers as one consumed marker",
      filters: { pattern: "@paseo", contains: "@paseo" },
      body: "@paseo priority=high investigate",
      expected: "priority=high investigate",
    },
    {
      name: "uses an overlapping contains marker that extends the pattern",
      filters: { pattern: "@paseo", contains: "@paseo /run" },
      body: "@paseo /run priority=high investigate",
      expected: "priority=high investigate",
    },
    {
      name: "keeps an input-shaped suffix of an overlapping contains marker",
      filters: { pattern: "@paseo", contains: "@paseo repo=hub" },
      body: "@paseo repo=hub priority=high investigate",
      expected: "repo=hub priority=high investigate",
    },
    {
      name: "uses the longer pattern when contains is inside it",
      filters: { pattern: "@paseo /run", contains: "/run" },
      body: "@paseo /run priority=high investigate",
      expected: "priority=high investigate",
    },
    {
      name: "uses the first boundary-valid repeated contains marker",
      filters: { pattern: "@paseo", contains: "/run" },
      body: "@paseo /run prose /run priority=high investigate",
      expected: "prose /run priority=high investigate",
    },
    {
      name: "does not treat an inside-word contains match as a marker",
      filters: { pattern: "@paseo", contains: "run" },
      body: "@paseo prerun priority=high investigate",
      expected: "prerun priority=high investigate",
    },
    {
      name: "does not bypass a non-boundary pattern prefix with contains",
      filters: { pattern: "@paseo", contains: "/run" },
      body: "@paseoX /run priority=high investigate",
      expected: "@paseoX /run priority=high investigate",
    },
    {
      name: "preserves a leading input-shaped pattern before a later command",
      filters: { pattern: "repo=hub", contains: "/run" },
      body: "repo=hub /run priority=high investigate",
      expected: "repo=hub priority=high investigate",
    },
  ])("$name", ({ filters, body, expected }) => {
    assert.equal(readLinearInvocationParserMessage(commentEvent(body), filters), expected);
  });
});

function configuration() {
  const base = {
    id: "work",
    environment: "runner",
    max_runtime: "1h",
    idle_timeout: "5m",
    agent: { provider: "codex" },
    prompt: [{ text: "Work from ${{ paseo.context }}" }],
  };
  return compileHubConfig({
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "scout",
        on: "linear.issue_entered_scope",
        max_runtime: "2h",
        filters: {
          project: "project-1",
          states: ["ready"],
          exclude_labels: ["no-paseo"],
        },
        steps: [base],
      },
      {
        name: "assignment",
        on: "linear.issue_assigned",
        max_runtime: "2h",
        filters: { project: "project-1", from_users: ["operator"] },
        steps: [base],
      },
      {
        name: "comment",
        on: "linear.comment_created",
        max_runtime: "2h",
        filters: { project: "project-1", from_users: ["operator"], contains: "@paseo" },
        steps: [base],
      },
    ],
  });
}

function sessionConfiguration(
  filters: {
    team?: string;
    from_users?: string[];
    source?: string[];
    allow_automations?: boolean;
  } = {},
) {
  const base = {
    id: "work",
    environment: "runner",
    max_runtime: "1h",
    idle_timeout: "5m",
    agent: { provider: "codex" },
    prompt: [{ text: "Work from ${{ paseo.context }}" }],
  };
  const shared = {
    team: filters.team ?? LINEAR_FIXTURE.teamId,
    ...(filters.source === undefined ? {} : { source: filters.source }),
    ...(filters.allow_automations === undefined
      ? {}
      : { allow_automations: filters.allow_automations }),
  };
  const from_users = filters.from_users ?? [LINEAR_FIXTURE.humanId];
  return compileHubConfig({
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "delegated",
        on: "linear.agent_session_created",
        max_runtime: "2h",
        filters: { ...shared, from_users },
        steps: [base],
      },
      {
        name: "followed-up",
        on: "linear.agent_session_prompted",
        max_runtime: "2h",
        filters: { ...shared, from_users },
        steps: [base],
      },
    ],
  });
}

function session(fixture: LinearFixtureName): NormalizedLinearAgentSessionEvent {
  const event = normalizeLinearEvent(readLinearFixture(fixture));
  if (event?.type !== "agent_session") throw new Error(`expected a session fixture: ${fixture}`);
  return event;
}

function names(matches: ReturnType<typeof matchLinearTriggers>): string[] {
  return matches.map((match) => match.trigger.name);
}

function issue(
  overrides: Partial<NormalizedLinearIssueEvent> & {
    labelIds?: string[];
  } = {},
): NormalizedLinearIssueEvent {
  const { labelIds, ...event } = overrides;
  return {
    type: "issue",
    action: "create",
    id: "issue-1",
    organizationId: "linear-org",
    actor: { id: "operator" },
    issue: {
      id: "issue-1",
      identifier: "ENG-42",
      title: "Ship the feature",
      description: "Useful context",
      projectId: "project-1",
      stateId: "ready",
      assigneeId: "user-1",
      labelIds: labelIds ?? [],
    },
    updatedFrom: {},
    ...event,
  };
}

function commentEvent(body = "@paseo please investigate"): NormalizedLinearCommentEvent {
  const event = issue();
  return {
    type: "comment",
    action: "create",
    id: "comment-1",
    organizationId: event.organizationId,
    actor: event.actor,
    comment: { id: "comment-1", issueId: event.issue.id, body },
    issue: event.issue,
  };
}
