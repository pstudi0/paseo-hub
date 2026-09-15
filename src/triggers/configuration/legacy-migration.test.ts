import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { migrateLegacyBundle } from "./index.js";

const hub = `
environments:
  runner:
    kind: daemon
    daemon: devbox
    cwd: /workspace/company
agents:
  codex:
    provider: codex
    model: gpt-5.6-sol
`;

describe("legacy project bundle migration", () => {
  it("inlines a one-step workflow and its prompt partial into one trigger document", () => {
    const migrated = migrateLegacyBundle({
      files: [
        { path: ".paseo/hub.yml", content: hub },
        {
          path: ".paseo/workflows/slack.yml",
          content: `
name: slack-help
on: slack.mention
max_runtime: 2h
filters:
  connection: acme-slack
  from_users: [U123]
steps:
  - id: work
    environment: runner
    max_runtime: 90m
    idle_timeout: 10m
    agent: codex
    prompt:
      - include: partials/safety.md
      - text: "Request: \${{ paseo.prompt }}"
    allow_outputs:
      - { type: slack.reply, max: 5 }
`,
        },
        {
          path: ".paseo/workflows/partials/safety.md",
          content: "Never disclose secrets.",
        },
      ],
    });

    assert.equal(migrated.length, 1);
    const trigger = migrated[0];
    assert.equal(trigger?.format, "single_run");
    if (trigger?.format !== "single_run") return;
    assert.match(trigger.yaml, /daemon: devbox/u);
    assert.match(trigger.yaml, /provider: codex/u);
    assert.match(trigger.yaml, /Never disclose secrets\.\n\s+Request:/u);
    assert.doesNotMatch(trigger.yaml, /include:|partials|steps:/u);
  });

  it("carries a Linear agent-session workflow's filters, authority, and issue branch into one document", () => {
    const migrated = migrateLegacyBundle({
      files: [
        {
          path: ".paseo/hub.yml",
          content: `
environments:
  issues:
    kind: daemon
    daemon: devbox
    cwd: /workspace/company
    worktree:
      mode: branch-off
      newBranch: linear/\${{ linear.issue.identifier }}
agents:
  codex:
    provider: codex
    model: gpt-5.6-sol
`,
        },
        {
          path: ".paseo/workflows/delegate.yml",
          content: `
name: delegate
on: linear.agent_session_created
max_runtime: 2h
filters:
  connection: acme-linear
  team: 6f1e7b2a-1b6e-4c47-9d2c-0d0d0d0d0d01
  from_users: [user-anthony]
  source: [delegation, mention]
  allow_automations: true
steps:
  - id: work
    environment: issues
    max_runtime: 90m
    idle_timeout: 10m
    agent: codex
    linear:
      on_start: started
      mirror:
        thoughts: none
    prompt:
      - text: "Handle \${{ paseo.prompt }}"
`,
        },
      ],
    });

    assert.equal(migrated.length, 1);
    const trigger = migrated[0];
    assert.equal(trigger?.format, "single_run");
    if (trigger?.format !== "single_run") return;
    assert.match(trigger.yaml, /team: 6f1e7b2a-1b6e-4c47-9d2c-0d0d0d0d0d01/u);
    assert.match(trigger.yaml, /source:\n\s+- delegation\n\s+- mention/u);
    assert.match(trigger.yaml, /allow_automations: true/u);
    assert.match(trigger.yaml, /newBranch: linear\/\$\{\{ linear\.issue\.identifier \}\}/u);
    assert.match(
      trigger.yaml,
      /linear:\n\s+on_start: started\n\s+mirror:\n\s+actions: true\n\s+thoughts: none\n\s+plan: true\n\s+permissions: true/u,
    );
    assert.doesNotMatch(trigger.yaml, /delegate: true|steps:/u);

    const compiled = trigger.compiled.events[0];
    assert.equal(compiled?.on, "linear.agent_session_created");
    assert.deepEqual(compiled?.filters, {
      connection: "acme-linear",
      team: "6f1e7b2a-1b6e-4c47-9d2c-0d0d0d0d0d01",
      from_users: ["user-anthony"],
      source: ["delegation", "mention"],
      allow_automations: true,
    });
    assert.deepEqual(compiled?.steps[0]?.linear, {
      onStart: { kind: "type", type: "started" },
      delegate: false,
      mirror: { actions: true, thoughts: "none", plan: true, permissions: true },
    });
  });

  it("preserves a multi-step workflow as one self-contained normalized legacy trigger", () => {
    const migrated = migrateLegacyBundle({
      files: [
        { path: ".paseo/hub.yml", content: hub },
        {
          path: ".paseo/workflows/route.yml",
          content: `
name: route
on: manual.run
max_runtime: 2h
steps:
  - id: classify
    environment: runner
    max_runtime: 2m
    idle_timeout: 30s
    agent: codex
    prompt: [{ text: classify }]
  - id: work
    environment: runner
    max_runtime: 90m
    idle_timeout: 10m
    agent: codex
    prompt: [{ text: work }]
`,
        },
      ],
    });

    assert.equal(migrated[0]?.format, "legacy_multistep");
    const trigger = migrated[0];
    if (trigger?.format !== "legacy_multistep") return;
    assert.equal(trigger.normalized.trigger.steps.length, 2);
    assert.equal(trigger.normalized.environments.length, 1);
    assert.deepEqual(trigger.conversionBlockers, ["trigger has multiple steps"]);
  });
});
