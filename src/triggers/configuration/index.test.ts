import assert from "node:assert/strict";
import { parseProjectConfiguration } from "../../configuration/store.js";
import type { ProjectConfigurationRevisionRecord } from "../../db/types.js";
import { describe, it } from "vitest";
import {
  compileTriggerDocument,
  parseTriggerDocument,
  serializeTriggerDocument,
  TriggerDocumentError,
} from "./index.js";

function reportsIssue(
  error: unknown,
  path: string,
  message: RegExp | string,
): error is TriggerDocumentError {
  return (
    error instanceof TriggerDocumentError &&
    error.issues.some(
      (issue) =>
        issue.path.join(".") === path &&
        (typeof message === "string" ? issue.message === message : message.test(issue.message)),
    )
  );
}

function reportsMissingEvent(error: unknown): boolean {
  return (
    error instanceof TriggerDocumentError &&
    error.issues.some(
      ({ path, message }) => path.join(".") === "on" && /at least one event/u.test(message),
    )
  );
}

const trigger = `
name: engineering-requests
enabled: true
on:
  slack.mention:
    connection: acme-slack
    filters:
      channels: [engineering]
      from_users: [U0BNGPZEXT2]
  github.issue_comment:
    connection: getpaseo-github
    filters:
      contains: "@paseo-bot"
      from_users: [boudra]
inputs:
  model:
    type: string
    default: codex
    choices: [codex, claude]
run:
  target:
    daemon: devbox
    cwd: /workspace/company
  agent:
    select: \${{ paseo.inputs.model }}
    choices:
      codex:
        provider: codex
        model: gpt-5.6-sol
      claude:
        provider: claude
        model: claude-opus-5
  max_runtime: 90m
  idle_timeout: 10m
  github:
    connection: getpaseo-github
    repositories: [getpaseo/paseo, getpaseo/hub]
    permissions:
      contents: write
      pull_requests: write
  prompt: |
    Use Paseo when delegation is useful.
    \${{ paseo.prompt }}
  outputs:
    slack.reply:
      max: 5
`;

describe("self-contained trigger documents", () => {
  it("compiles and preserves a configurable startup timeout", () => {
    const yaml = trigger.replace("  max_runtime: 90m", "  max_runtime: 90m\n  startup_timeout: 3m");
    const compiled = compileTriggerDocument(yaml);
    assert.equal(compiled.events[0]?.steps[0]?.startupTimeoutMs, 180_000);
    assert.equal(
      parseTriggerDocument(serializeTriggerDocument(compiled.authored)).run.startup_timeout,
      "3m",
    );
  });

  it.each(["0s", "25h", "invalid"])("rejects invalid startup timeout %s", (duration) => {
    assert.throws(
      () =>
        compileTriggerDocument(
          trigger.replace(
            "  max_runtime: 90m",
            `  max_runtime: 90m\n  startup_timeout: ${duration}`,
          ),
        ),
      /startup_timeout/,
    );
  });

  it("compiles every input event to one launch against the inline target and agent choices", () => {
    const compiled = compileTriggerDocument(trigger);

    assert.equal(compiled.authored.name, "engineering-requests");
    assert.equal(compiled.environment.kind, "daemon");
    assert.equal(compiled.events.length, 2);
    assert.deepEqual(
      compiled.events.map(({ on }) => on),
      ["slack.mention", "github.issue_comment"],
    );
    assert.deepEqual(compiled.events[0]?.steps[0]?.agent, {
      selector: "${{ paseo.inputs.model }}",
      choices: {
        codex: { provider: "codex", model: "gpt-5.6-sol" },
        claude: { provider: "claude", model: "claude-opus-5" },
      },
    });
    assert.deepEqual(compiled.events[0]?.steps[0]?.allowOutputs, [
      { type: "slack.reply", max: 5, required: false },
    ]);
    assert.deepEqual(compiled.events[1]?.steps[0]?.allowOutputs, [
      { type: "slack.reply", max: 5, required: false },
      { type: "github.reply", required: false },
    ]);
  });

  it("round-trips the semantic document through canonical YAML", () => {
    const parsed = parseTriggerDocument(trigger);
    assert.deepEqual(parseTriggerDocument(serializeTriggerDocument(parsed)), parsed);
  });

  it("allows authenticated manual dispatches when no actor filter is authored", () => {
    const compiled = compileTriggerDocument(`
name: deploy
enabled: true
on:
  manual.run: {}
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: codex }
  prompt: Handle it
`);

    assert.deepEqual(compiled.events[0]?.filters?.from_users, ["*"]);
    assert.deepEqual(compiled.events[0]?.steps[0]?.allowOutputs, []);
  });

  it("automatically grants an unlimited event-native reply for a new conversational trigger", () => {
    const compiled = compileTriggerDocument(`
name: answer
on:
  slack.mention:
    connection: acme-slack
    filters: { from_users: ["*"] }
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Handle it
`);

    assert.deepEqual(compiled.events[0]?.steps[0]?.allowOutputs, [
      { type: "slack.reply", required: false },
    ]);
  });

  it("rejects a trigger without events at the document boundary", () => {
    assert.throws(
      () =>
        parseTriggerDocument(`
name: empty
on: {}
run:
  target: { daemon: local, cwd: /workspace }
  agent: { provider: codex }
  prompt: run
`),
      reportsMissingEvent,
    );
  });
});

it("applies the continuation default when reading old trigger revisions without rewriting their evidence", () => {
  const compiled = compileTriggerDocument(trigger);
  const stored = structuredClone({
    environments: [{ ...compiled.environment, daemonId: "daemon" }],
    triggers: compiled.events,
  });
  for (const event of stored.triggers) for (const step of event.steps) delete step.continuation;
  const revision: ProjectConfigurationRevisionRecord = {
    id: "revision",
    projectId: "project",
    organizationId: "org",
    version: 1,
    sourceKind: "manual",
    sourceEvidence: { kind: "organization_trigger_adapter" },
    rawYaml: trigger,
    normalizedConfiguration: stored,
    validationErrors: null,
    contentHash: "original",
    createdByUserId: "user",
    receivedAt: null,
    createdAt: new Date(),
    validatedAt: new Date(),
  };
  const loaded = parseProjectConfiguration(revision);
  assert.deepEqual(loaded.triggers[0]?.steps[0]?.continuation, { mode: "conversation" });
  assert.equal(stored.triggers[0]?.steps[0]?.continuation, undefined);
  const legacy = parseProjectConfiguration({ ...revision, sourceEvidence: { kind: "manual" } });
  assert.equal(legacy.triggers[0]?.steps[0]?.continuation, undefined);
  const migratedLegacy = parseProjectConfiguration({
    ...revision,
    rawYaml: JSON.stringify({
      name: "preserved-workflow",
      legacy_multistep: { trigger: stored.triggers[0], environments: stored.environments },
    }),
  });
  assert.deepEqual(migratedLegacy, legacy);
});

describe("Linear agent session documents", () => {
  const TEAM = "6f1e7b2a-1b6e-4c47-9d2c-0d0d0d0d0d01";
  /** The design document's one-trigger-per-project example, with the names Hub settled on. */
  const linearAgent = `
name: linear-agent
enabled: true
on:
  linear.agent_session_created:
    connection: p-studio-linear
    filters:
      team: "${TEAM}"
      from_users: ["user-anthony", "user-colleague"]
      source: [delegation, mention]
  linear.agent_session_prompted:
    connection: p-studio-linear
    filters:
      team: "${TEAM}"
      from_users: ["*"]
run:
  target:
    daemon: cs8-senspace-vps
    cwd: /srv/senspace
    worktree:
      mode: branch-off
      newBranch: "linear/\${{ linear.issue.identifier }}"
      base: origin/main
  agent:
    provider: claude
    model: claude-opus-5
    mode: bypassPermissions
  continuation:
    mode: linear
  github:
    connection: p-studio-github
    repositories: [p-studio/senspace]
    permissions: { contents: write, pull_requests: write }
  linear:
    on_start: started
    on_pull_request: "In Review"
    mirror: { actions: true, thoughts: summary, plan: true }
  startup_timeout: 5m
  max_runtime: 3h
  idle_timeout: 20m
  auto_archive: false
  prompt: |
    Work in this worktree, open a pull request, then call hub.linear_response.
    \${{ paseo.context }}
    <user-prompt>
    \${{ paseo.prompt }}
    </user-prompt>
  outputs:
    linear.response: { max: 1, required: true }
    linear.ask: { max: 5 }
    linear.plan: { max: 50 }
    linear.link: { max: 5 }
`;

  it("compiles the design document's trigger into two session events sharing one issue workspace", () => {
    const compiled = compileTriggerDocument(linearAgent);
    assert.deepEqual(
      compiled.events.map(({ on }) => on),
      ["linear.agent_session_created", "linear.agent_session_prompted"],
    );
    assert.equal(compiled.environment.kind, "daemon");
    assert.deepEqual(compiled.environment.worktree, {
      mode: "branch-off",
      newBranch: "linear/${{ linear.issue.identifier }}",
      base: "origin/main",
    });
    assert.deepEqual(compiled.events[0]?.filters, {
      team: TEAM,
      from_users: ["user-anthony", "user-colleague"],
      source: ["delegation", "mention"],
      connection: "p-studio-linear",
    });
    assert.deepEqual(compiled.events[1]?.filters, {
      team: TEAM,
      from_users: ["*"],
      connection: "p-studio-linear",
    });
    for (const event of compiled.events) {
      assert.deepEqual(event.steps[0]?.continuation, { mode: "linear" });
      assert.deepEqual(event.steps[0]?.linear, {
        onStart: { kind: "type", type: "started" },
        onPullRequest: { kind: "name", name: "In Review" },
        delegate: false,
        mirror: { actions: true, thoughts: "summary", plan: true, permissions: true },
      });
      assert.equal(event.steps[0]?.autoArchive, false);
      assert.deepEqual(event.steps[0]?.allowOutputs.map(({ type }) => type).slice(0, 4), [
        "linear.response",
        "linear.ask",
        "linear.plan",
        "linear.link",
      ]);
    }
    assert.deepEqual(
      parseTriggerDocument(serializeTriggerDocument(compiled.authored)),
      compiled.authored,
    );
  });

  it("refuses the linear continuation and the linear block beside a non-session event", () => {
    const withSlack = linearAgent.replace(
      '  linear.agent_session_prompted:\n    connection: p-studio-linear\n    filters:\n      team: "' +
        TEAM +
        '"\n      from_users: ["*"]',
      '  slack.mention:\n    connection: acme-slack\n    filters: { from_users: ["*"] }',
    );
    assert.throws(
      () => parseTriggerDocument(withSlack),
      (error) =>
        reportsIssue(
          error,
          "run.continuation.mode",
          /Continuation mode "linear" is only available for linear\.agent_session_created and linear\.agent_session_prompted/u,
        ) && reportsIssue(error, "run.linear", /only available for linear\.agent_session/u),
    );
  });

  it("requires the Linear team at the document boundary and refuses issue-only filters at compile time", () => {
    assert.throws(
      () =>
        parseTriggerDocument(
          linearAgent.replace(
            `      team: "${TEAM}"\n      from_users: ["*"]`,
            '      from_users: ["*"]',
          ),
        ),
      (error) =>
        reportsIssue(
          error,
          "on.linear.agent_session_prompted.filters.team",
          "Linear team is required.",
        ),
    );
    assert.throws(
      () =>
        compileTriggerDocument(
          linearAgent.replace("      source: [delegation, mention]", "      states: [ready]"),
        ),
      /filters\.states is not available for linear\.agent_session_created/u,
    );
    assert.throws(
      () =>
        parseTriggerDocument(
          linearAgent.replace("source: [delegation, mention]", "source: [webhook]"),
        ),
      TriggerDocumentError,
    );
  });

  it("keeps session filters out of issue and comment triggers", () => {
    assert.throws(
      () =>
        compileTriggerDocument(`
name: assigned
on:
  linear.issue_assigned:
    connection: acme-linear
    filters: { from_users: ["*"], source: [delegation] }
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Handle it
`),
      /filters\.source is only available for linear\.agent_session_created and linear\.agent_session_prompted/u,
    );
  });
});
