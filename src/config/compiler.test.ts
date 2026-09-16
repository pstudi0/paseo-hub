import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  compileHubConfig,
  compiledConfigurationHash,
  parseCompiledHubConfig,
  rawConfigurationHash,
  type CompiledHubConfig,
  type CompiledStep,
  type CompiledTrigger,
} from "./compiler.js";

const environment = { name: "runner", kind: "daemon" as const, daemon: "runner", cwd: "/repo" };

function configuration(overrides: Record<string, unknown> = {}) {
  return {
    environments: [environment],
    triggers: [
      {
        name: "run",
        on: "manual.run",
        max_runtime: "1h",
        steps: [
          {
            id: "work",
            environment: "runner",
            max_runtime: "10m",
            idle_timeout: "1m",
            agent: { provider: "codex", model: "small" },
            prompt: [{ text: "Do the work." }],
            allow_outputs: [{ type: "manual.reply", max: 2 }],
            auto_archive: true,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function legacyAllowOutputs(allowOutputs: CompiledStep["allowOutputs"]) {
  return allowOutputs.map(({ type, max }) => ({ type, max }));
}

function legacyStep(step: CompiledStep) {
  return { ...step, allowOutputs: legacyAllowOutputs(step.allowOutputs) };
}

function legacyTrigger(trigger: CompiledTrigger) {
  return { ...trigger, steps: trigger.steps.map(legacyStep) };
}

function legacyCompiledConfiguration(compiled: CompiledHubConfig): unknown {
  const cloned = structuredClone(compiled);
  return { ...cloned, triggers: cloned.triggers.map(legacyTrigger) };
}

describe("workflow compiler", () => {
  it("preserves an authored startup timeout in stored compiled configurations", () => {
    const authored = configuration();
    Reflect.set(authored.triggers[0]!.steps[0]!, "startup_timeout", "3m");
    const compiled = compileHubConfig(authored);
    assert.equal(compiled.triggers[0]?.steps[0]?.startupTimeoutMs, 180_000);
    assert.deepEqual(parseCompiledHubConfig(compiled), compiled);
  });

  it.each([
    "paseo.event.github.delivery_id",
    "paseo.prompt",
    "paseo.context",
    "paseo.inputs.repo",
    "values.branch",
    "steps.prepare.outputs.branch",
  ])("rejects unsupported newBranch expression %s with field provenance", (expression) => {
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          environments: [
            {
              ...environment,
              worktree: {
                mode: "branch-off",
                newBranch: "trigger-${{ " + expression + " }}",
              },
            },
          ],
        }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.deepEqual(Reflect.get(error, "path"), [
          "environments",
          "runner",
          "worktree",
          "newBranch",
        ]);
        assert.match(
          error.message,
          /unsupported path|execution templates support only paseo\.execution\.id paths/iu,
        );
        return true;
      },
    );
  });

  it("accepts only the execution-scoped worktree merge value", () => {
    assert.doesNotThrow(() =>
      compileHubConfig({
        ...configuration(),
        environments: [
          {
            ...environment,
            worktree: {
              mode: "branch-off",
              newBranch: "trigger-${{ paseo.execution.id }}",
            },
          },
        ],
      }),
    );
  });

  it("preserves opaque provider options and leaves an omitted mode omitted", () => {
    const sourceOptions = {
      sandbox_workspace_write: {
        writable_roots: ["/var/cache/npm"],
        network_access: false,
      },
      native_null: null,
      native_template_string: "${{ provider.owns.this }}",
    };
    const raw = configuration();
    setAgent(raw, {
      provider: "codex",
      model: "gpt-5.5",
      options: sourceOptions,
    });

    const compiled = compileHubConfig(raw);
    const agent = compiled.triggers[0]?.steps[0]?.agent;
    assert.ok(agent !== undefined && !("selector" in agent));
    if (agent === undefined || "selector" in agent) return;
    const options = agent.options;

    assert.deepEqual(options, sourceOptions);
    assert.equal(agent.mode, undefined);
    assert.deepEqual(parseCompiledHubConfig(compiled), compiled);
    assert.notEqual(options, sourceOptions);
  });

  it.each([null, [], "native", true, 1])("rejects non-object provider options %#", (options) => {
    const raw = configuration();
    setAgent(raw, { provider: "codex", options });
    assert.throws(() => compileHubConfig(raw), /options/iu);
  });

  it("rejects non-JSON provider option values and authored tool policy", () => {
    const raw = configuration();
    setAgent(raw, {
      provider: "codex",
      options: { native: undefined },
    });
    assert.throws(() => compileHubConfig(raw), /options/iu);

    setAgent(raw, {
      provider: "codex",
      toolPolicy: {
        preapproved: [{ kind: "mcp", server: "hub", tool: "arbitrary" }],
      },
    });
    assert.throws(() => compileHubConfig(raw), /unrecognized key.*toolPolicy/iu);
  });

  it("compiles the complete multi-step contract and freezes it", () => {
    const compiled = compileHubConfig({
      ...configuration(),
      triggers: [
        {
          ...configuration().triggers[0],
          inputs: { repo: { type: "string", choices: ["paseo", "hub"] } },
          values: { selected: "${{ paseo.inputs.repo ?? steps.classify.outputs.repo }}" },
          steps: [
            {
              ...configuration().triggers[0]!.steps[0],
              id: "classify",
              if: "${{ paseo.inputs.repo == null }}",
              output: {
                schema: { type: "object", properties: { repo: { enum: ["paseo", "hub"] } } },
              },
            },
            {
              ...configuration().triggers[0]!.steps[0],
              id: "work",
              if: "${{ values.selected == 'hub' }}",
              prompt: [{ text: "${{ paseo.prompt }} / ${{ values.selected }}" }],
            },
          ],
        },
      ],
    });
    const trigger = compiled.triggers[0]!;
    assert.equal(trigger.steps.length, 2);
    assert.ok(trigger.values["selected"]);
    const firstStep = trigger.steps[0];
    assert.ok(firstStep?.output);
    const schema = firstStep.output.schema;
    assert.ok(typeof schema === "object" && schema !== null && !Array.isArray(schema));
    assert.equal(schema["type"], "object");
    assert.equal(Object.isFrozen(compiled), true);
    assert.equal(Object.isFrozen(trigger.steps[1]), true);
  });

  it("compiles required output declarations and rejects an unusable maximum", () => {
    const trigger = configuration().triggers[0]!;
    const step = trigger.steps[0]!;
    const compiled = compileHubConfig({
      ...configuration(),
      triggers: [
        {
          ...trigger,
          steps: [
            {
              ...step,
              allow_outputs: [{ type: "discord.reply", max: 1, required: true }],
            },
          ],
        },
      ],
    });
    assert.deepEqual(compiled.triggers[0]?.steps[0]?.allowOutputs, [
      { type: "discord.reply", max: 1, required: true },
    ]);

    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...trigger,
              steps: [
                { ...step, allow_outputs: [{ type: "discord.reply", max: 0, required: true }] },
              ],
            },
          ],
        }),
      /required outputs must have max at least 1/iu,
    );
  });

  it("keeps explicit step environment templates and applies safe GitHub authority defaults", () => {
    const raw = configuration();
    const step = raw.triggers[0]!.steps[0]!;
    Reflect.set(step, "env", {
      SOME_TOKEN: "prefix-${{ paseo.connections.some-connection.token }}",
    });
    Reflect.set(step, "github", {
      connection: "getpaseo-github",
      repositories: ["getpaseo/paseo"],
    });

    const compiled = compileHubConfig(raw);
    assert.deepEqual(compiled.triggers[0]?.steps[0]?.env, {
      SOME_TOKEN: "prefix-${{ paseo.connections.some-connection.token }}",
    });
    assert.deepEqual(compiled.triggers[0]?.steps[0]?.github, {
      connection: "getpaseo-github",
      repositories: ["getpaseo/paseo"],
      permissions: { contents: "read" },
      durationMs: 60 * 60 * 1000,
    });
    assert.deepEqual(parseCompiledHubConfig(compiled), compiled);
  });

  it("uses only the GitHub event repository when a GitHub step omits repositories", () => {
    const raw = configuration();
    const step = raw.triggers[0]!.steps[0]!;
    const compiled = compileHubConfig({
      ...raw,
      triggers: [
        {
          ...raw.triggers[0],
          on: "github.push",
          filters: { from_users: ["github-user"] },
          steps: [{ ...step, github: { connection: "getpaseo-github" } }],
        },
      ],
    });

    assert.deepEqual(compiled.triggers[0]?.steps[0]?.github, {
      connection: "getpaseo-github",
      permissions: { contents: "read" },
      durationMs: 60 * 60 * 1000,
    });
  });

  it("allows a project-scoped Linear scout but keeps reactive Linear triggers actor-allowlisted", () => {
    const raw = configuration();
    const trigger = raw.triggers[0]!;
    assert.doesNotThrow(() =>
      compileHubConfig({
        ...raw,
        triggers: [
          {
            ...trigger,
            on: "linear.issue_entered_scope",
            filters: { project: "linear-project-id", states: ["ready"] },
          },
        ],
      }),
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...raw,
          triggers: [{ ...trigger, on: "linear.issue_entered_scope", filters: {} }],
        }),
      /requires filters\.project/iu,
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...raw,
          triggers: [
            { ...trigger, on: "linear.comment_created", filters: { project: "linear-project-id" } },
          ],
        }),
      /filters\.from_users/iu,
    );
  });
  it("requires explicit repositories for non-GitHub authority", () => {
    const raw = configuration();
    const step = raw.triggers[0]!.steps[0]!;
    assert.throws(
      () =>
        compileHubConfig({
          ...raw,
          triggers: [
            {
              ...raw.triggers[0],
              steps: [{ ...step, github: { connection: "getpaseo-github" } }],
            },
          ],
        }),
      /trigger run step work github\.repositories is required for non-GitHub triggers/iu,
    );
  });

  it("rejects GitHub authority values that could expand beyond authored scope", () => {
    const base = configuration();
    const step = base.triggers[0]!.steps[0]!;
    const cases = [
      {
        github: {
          connection: "getpaseo-github",
          repositories: ["getpaseo/paseo"],
          permissions: { contents: "admin" },
        },
        expected: /github\.permissions\.contents.*admin.*not supported/iu,
      },
      {
        github: {
          connection: "getpaseo-github",
          repositories: ["getpaseo/paseo"],
          permissions: { invented: "read" },
        },
        expected: /github\.permissions\.invented.*unknown GitHub permission/iu,
      },
      {
        github: {
          connection: "getpaseo-github",
          repositories: ["getpaseo/paseo"],
          duration: "2h",
        },
        expected: /github\.duration.*must not exceed 1h/iu,
      },
    ] as const;

    for (const candidate of cases) {
      assert.throws(
        () =>
          compileHubConfig({
            ...base,
            triggers: [{ ...base.triggers[0], steps: [{ ...step, github: candidate.github }] }],
          }),
        candidate.expected,
      );
    }
  });

  it.each([
    ["attestations", "write"],
    ["artifact_metadata", "read"],
    ["code_quality", "write"],
    ["merge_queues", "write"],
    ["organization_copilot_agent_settings", "read"],
    ["enterprise_custom_properties_for_organizations", "admin"],
  ] as const)("accepts the current GitHub App permission %s at level %s", (name, level) => {
    const raw = configuration();
    const step = raw.triggers[0]!.steps[0]!;
    Reflect.set(step, "github", {
      connection: "getpaseo-github",
      repositories: ["getpaseo/paseo"],
      permissions: { [name]: level },
    });

    const compiled = compileHubConfig(raw);
    assert.deepEqual(compiled.triggers[0]?.steps[0]?.github?.permissions, { [name]: level });
  });

  it.each(["actions_variables", "repository_advisories"])(
    "rejects %s because it is not in the versioned installation-token request vocabulary",
    (name) => {
      const raw = configuration();
      const step = raw.triggers[0]!.steps[0]!;
      Reflect.set(step, "github", {
        connection: "getpaseo-github",
        repositories: ["getpaseo/paseo"],
        permissions: { [name]: "write" },
      });

      assert.throws(() => compileHubConfig(raw), /unknown GitHub permission/iu);
    },
  );

  it("rejects GitHub authority env collisions at the authored step boundary", () => {
    const raw = configuration();
    const step = raw.triggers[0]!.steps[0]!;
    Reflect.set(step, "env", {
      GH_TOKEN: "user-authored",
      GIT_CONFIG_COUNT: "1",
    });
    Reflect.set(step, "github", {
      connection: "getpaseo-github",
      repositories: ["getpaseo/paseo"],
    });

    assert.throws(
      () => compileHubConfig(raw),
      /trigger run step work env\.(GH_TOKEN|GIT_CONFIG_COUNT).*reserved/iu,
    );
  });

  it.each(["GITHUB_TOKEN", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_12", "GIT_TERMINAL_PROMPT"])(
    "rejects reserved GitHub environment key %s",
    (key) => {
      const raw = configuration();
      const step = raw.triggers[0]!.steps[0]!;
      Reflect.set(step, "env", { [key]: "user-authored" });
      Reflect.set(step, "github", {
        connection: "getpaseo-github",
        repositories: ["getpaseo/paseo"],
      });

      assert.throws(() => compileHubConfig(raw), /reserved by the step-level github authority/iu);
    },
  );

  it("rejects duplicate IDs, unknown references, forward references, and value cycles", () => {
    const trigger = configuration().triggers[0]!;
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [{ ...trigger, steps: [trigger.steps[0]!, trigger.steps[0]!] }],
        }),
      /duplicate step id/iu,
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [{ ...trigger, values: { selected: "${{ steps.missing.outputs.repo }}" } }],
        }),
      /unknown step/iu,
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...trigger,
              steps: [
                { ...trigger.steps[0]!, if: "${{ steps.later.outputs.repo == 'hub' }}" },
                { ...trigger.steps[0]!, id: "later", output: { schema: { type: "object" } } },
              ],
            },
          ],
        }),
      /forward step/iu,
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...trigger,
              values: { first: "${{ values.second }}", second: "${{ values.first }}" },
            },
          ],
        }),
      /cycle/iu,
    );
  });

  it("requires declared output schemas for output paths and validates JSON Schema", () => {
    const trigger = configuration().triggers[0]!;
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...trigger,
              steps: [
                { ...trigger.steps[0]!, id: "first" },
                {
                  ...trigger.steps[0]!,
                  id: "second",
                  if: "${{ steps.first.outputs.repo == 'hub' }}",
                },
              ],
            },
          ],
        }),
      /without an output schema/iu,
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...trigger,
              steps: [{ ...trigger.steps[0]!, output: { schema: { type: "not-a-schema" } } }],
            },
          ],
        }),
      /invalid JSON Schema/iu,
    );
  });

  it("rejects every dynamic inline agent configuration", () => {
    const trigger = configuration().triggers[0]!;
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...trigger,
              steps: [{ ...trigger.steps[0]!, agent: { provider: "${{ paseo.prompt }}" } }],
            },
          ],
        }),
      /dynamic inline agent configurations are not allowed/iu,
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...trigger,
              inputs: { provider: { type: "string" } },
              steps: [
                { ...trigger.steps[0]!, agent: { provider: "${{ paseo.inputs.provider }}" } },
              ],
            },
          ],
        }),
      /dynamic inline agent configurations are not allowed/iu,
    );
  });

  it("allows ambient context only in authored step prompts", () => {
    const trigger = configuration().triggers[0]!;
    assert.doesNotThrow(() =>
      compileHubConfig({
        ...configuration(),
        triggers: [
          {
            ...trigger,
            steps: [{ ...trigger.steps[0]!, prompt: [{ text: "${{ paseo.context }}" }] }],
          },
        ],
      }),
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...trigger,
              steps: [{ ...trigger.steps[0]!, if: "${{ paseo.context }}" }],
            },
          ],
        }),
      /paseo\.context outside a step prompt/iu,
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...trigger,
              steps: [
                {
                  ...trigger.steps[0]!,
                  agent: { provider: "${{ paseo.context }}" },
                },
              ],
            },
          ],
        }),
      /dynamic inline agent configurations are not allowed/iu,
    );
  });

  it("rejects the removed prompt inventory compatibility key", () => {
    const trigger = configuration().triggers[0]!;
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...trigger,
              steps: [{ ...trigger.steps[0]!, inject_tool_inventory: false }],
            },
          ],
        }),
      /inject_tool_inventory|unrecognized key/iu,
    );
  });

  it("resolves finite referenced output authority and rejects unprovable composition authority", () => {
    const trigger = configuration().triggers[0]!;
    const outputSchema = {
      type: "object",
      properties: {
        provider: { $ref: "#/$defs/provider" },
      },
      $defs: { provider: { enum: ["codex"] } },
    };
    assert.doesNotThrow(() =>
      compileHubConfig(
        {
          ...configuration(),
          triggers: [
            {
              ...trigger,
              steps: [
                { ...trigger.steps[0]!, id: "classify", output: { schema: outputSchema } },
                {
                  ...trigger.steps[0]!,
                  id: "work",
                  agent: "${{ steps.classify.outputs.provider }}",
                },
              ],
            },
          ],
        },
        { namedAgents: { codex: { provider: "codex" } } },
      ),
    );
    assert.throws(
      () =>
        compileHubConfig(
          {
            ...configuration(),
            triggers: [
              {
                ...trigger,
                steps: [
                  {
                    ...trigger.steps[0]!,
                    id: "classify",
                    output: {
                      schema: {
                        type: "object",
                        properties: {
                          provider: { oneOf: [{ enum: ["codex"] }, { const: "opus" }] },
                        },
                      },
                    },
                  },
                  {
                    ...trigger.steps[0]!,
                    id: "work",
                    agent: "${{ steps.classify.outputs.provider }}",
                  },
                ],
              },
            ],
          },
          { namedAgents: { codex: { provider: "codex" }, opus: { provider: "claude" } } },
        ),
      /provable finite choices/iu,
    );
  });

  it("re-establishes the multi-step contract for stored JSON and hashes all compiled fields", () => {
    const compiled = compileHubConfig(configuration());
    assert.deepEqual(parseCompiledHubConfig(compiled), compiled);
    const legacyConfiguration = legacyCompiledConfiguration(compiled);
    assert.deepEqual(parseCompiledHubConfig(legacyConfiguration), compiled);
    assert.throws(
      () =>
        parseCompiledHubConfig({
          ...compiled,
          triggers: [{ ...compiled.triggers[0]!, steps: [] }],
        }),
      /invalid compiled workflow contract/iu,
    );
    assert.notEqual(rawConfigurationHash(configuration()), compiledConfigurationHash(compiled));
    assert.notEqual(
      compiledConfigurationHash(compiled),
      compiledConfigurationHash(
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...configuration().triggers[0],
              steps: [
                {
                  ...configuration().triggers[0]!.steps[0],
                  output: { schema: { type: "object" } },
                },
              ],
            },
          ],
        }),
      ),
    );
  });

  it("rejects removed trigger syntax and keeps manual partial behavior explicit", () => {
    assert.throws(
      () => compileHubConfig({ ...configuration(), timeout: "1m" }),
      /timeout.*max_runtime/iu,
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [{ ...configuration().triggers[0], environment: "runner" }],
        }),
      /trigger-level environment/iu,
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...configuration().triggers[0],
              steps: [
                {
                  ...configuration().triggers[0]!.steps[0],
                  prompt: [{ include: "partials/developer.md" }],
                },
              ],
            },
          ],
        }),
      /compiled without a prompt partial bundle/iu,
    );
  });

  it("rejects workflow steps that resolve to non-daemon environments", () => {
    const trigger = configuration().triggers[0]!;
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          environments: [{ name: "docker", kind: "docker", image: "paseo/test" }],
          triggers: [
            {
              ...trigger,
              steps: [{ ...trigger.steps[0]!, environment: "docker" }],
            },
          ],
        }),
      /daemon environment/iu,
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          environments: [{ name: "fly", kind: "fly", image: "paseo/test" }],
          triggers: [
            {
              ...trigger,
              steps: [{ ...trigger.steps[0]!, environment: "fly" }],
            },
          ],
        }),
      /daemon environment/iu,
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          environments: [environment, { name: "docker", kind: "docker", image: "paseo/test" }],
          triggers: [
            {
              ...trigger,
              inputs: { runner: { type: "string", choices: ["runner", "docker"] } },
              steps: [
                {
                  ...trigger.steps[0]!,
                  environment: "${{ paseo.inputs.runner }}",
                },
              ],
            },
          ],
        }),
      /environment choice docker must be a daemon environment/iu,
    );
  });
});

function setAgent(raw: ReturnType<typeof configuration>, agent: unknown): void {
  Reflect.set(raw.triggers[0]!.steps[0]!, "agent", agent);
}

const ISSUE_ONLY_FILTER_VALUES: Record<string, unknown> = {
  project: "p",
  states: ["x"],
  assignees: ["x"],
  labels: ["x"],
  exclude_labels: ["x"],
  pattern: "x",
  contains: "x",
};

function withContinuation(compiled: CompiledHubConfig, mode: "linear" | "conversation") {
  const stored = structuredClone({
    environments: compiled.environments,
    triggers: compiled.triggers,
  });
  for (const trigger of stored.triggers) {
    for (const step of trigger.steps) step.continuation = { mode };
  }
  return stored;
}

function newBranchOf(compiled: CompiledHubConfig): string | undefined {
  const [first] = compiled.environments;
  if (first?.kind !== "daemon" || first.worktree?.mode !== "branch-off") return undefined;
  return first.worktree.newBranch;
}

describe("Linear agent session configuration", () => {
  const TEAM = "6f1e7b2a-1b6e-4c47-9d2c-0d0d0d0d0d01";

  function sessionTrigger(
    on: "linear.agent_session_created" | "linear.agent_session_prompted",
    overrides: Record<string, unknown> = {},
  ) {
    const base = configuration().triggers[0]!;
    return {
      ...base,
      name: on === "linear.agent_session_created" ? "delegated" : "followed-up",
      on,
      filters: {
        team: TEAM,
        from_users: on === "linear.agent_session_created" ? ["user-anthony"] : ["*"],
      },
      ...overrides,
    };
  }

  it("compiles session filters and the linear authority block into a re-readable contract", () => {
    const compiled = compileHubConfig({
      ...configuration(),
      triggers: [
        sessionTrigger("linear.agent_session_created", {
          filters: {
            team: TEAM,
            from_users: ["user-anthony"],
            source: ["delegation", "mention"],
            allow_automations: true,
          },
          steps: [
            {
              ...configuration().triggers[0]!.steps[0]!,
              linear: { on_start: "started", on_pull_request: "In Review", delegate: true },
            },
          ],
        }),
      ],
    });
    assert.deepEqual(compiled.triggers[0]?.filters, {
      team: TEAM,
      from_users: ["user-anthony"],
      source: ["delegation", "mention"],
      allow_automations: true,
    });
    assert.deepEqual(compiled.triggers[0]?.steps[0]?.linear, {
      onStart: { kind: "type", type: "started" },
      onPullRequest: { kind: "name", name: "In Review" },
      delegate: true,
      mirror: { actions: true, thoughts: "summary", plan: true, permissions: true },
    });
    assert.deepEqual(parseCompiledHubConfig(structuredClone(compiled)), compiled);
    assert.equal(compiledConfigurationHash(compiled), compiledConfigurationHash(compiled));
  });

  it("requires a team and named humans for a delegation, and any allowlist for a follow-up", () => {
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            sessionTrigger("linear.agent_session_created", { filters: { from_users: ["u"] } }),
          ],
        }),
      /trigger delegated requires filters\.team for linear\.agent_session_created/u,
    );
    for (const from_users of [["*"], ["user-anthony", "*"]]) {
      for (const allow_automations of [undefined, true]) {
        assert.throws(
          () =>
            compileHubConfig({
              ...configuration(),
              triggers: [
                sessionTrigger("linear.agent_session_created", {
                  filters: {
                    team: TEAM,
                    from_users,
                    ...(allow_automations === undefined ? {} : { allow_automations }),
                  },
                }),
              ],
            }),
          /requires explicit Linear user IDs in filters\.from_users for linear\.agent_session_created; "\*" is not allowed/u,
        );
      }
    }
    for (const filters of [{ team: TEAM }, { team: TEAM, allow_automations: false }]) {
      assert.throws(
        () =>
          compileHubConfig({
            ...configuration(),
            triggers: [sessionTrigger("linear.agent_session_created", { filters })],
          }),
        /trigger delegated requires explicit Linear user IDs in filters\.from_users or filters\.allow_automations: true for linear\.agent_session_created; a delegation runs code on your daemon/u,
      );
    }
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [sessionTrigger("linear.agent_session_prompted", { filters: { team: TEAM } })],
        }),
      /trigger followed-up requires a non-empty filters\.from_users allowlist for linear\.agent_session_prompted/u,
    );
    assert.doesNotThrow(() =>
      compileHubConfig({
        ...configuration(),
        triggers: [sessionTrigger("linear.agent_session_prompted")],
      }),
    );
  });

  it("accepts a triage delegation that admits automations without naming any human", () => {
    const compiled = compileHubConfig({
      ...configuration(),
      triggers: [
        sessionTrigger("linear.agent_session_created", {
          filters: { team: TEAM, allow_automations: true },
        }),
      ],
    });
    assert.deepEqual(compiled.triggers[0]?.filters, { team: TEAM, allow_automations: true });
    assert.deepEqual(parseCompiledHubConfig(structuredClone(compiled)), compiled);
  });

  it.each(["project", "states", "assignees", "labels", "exclude_labels", "pattern", "contains"])(
    "refuses the issue-only filter %s on a session event",
    (key) => {
      const value = ISSUE_ONLY_FILTER_VALUES[key];
      assert.throws(
        () =>
          compileHubConfig({
            ...configuration(),
            triggers: [
              sessionTrigger("linear.agent_session_created", {
                filters: { team: TEAM, from_users: ["u"], [key]: value },
              }),
            ],
          }),
        (error) => {
          assert.ok(error instanceof Error);
          assert.deepEqual(Reflect.get(error, "path"), ["triggers", "delegated", "filters"]);
          assert.match(
            error.message,
            new RegExp(
              `filters\\.${key} is not available for linear\\.agent_session_created; the session payload carries no such field`,
              "u",
            ),
          );
          return true;
        },
      );
    },
  );

  it.each([
    ["team", TEAM],
    ["source", ["delegation"]],
    ["allow_automations", true],
  ])("refuses the session-only filter %s on an issue event", (key, value) => {
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...configuration().triggers[0]!,
              on: "linear.issue_assigned",
              filters: { from_users: ["u"], [key]: value },
            },
          ],
        }),
      new RegExp(
        `trigger run filters\\.${key} is only available for linear\\.agent_session_created and linear\\.agent_session_prompted`,
        "u",
      ),
    );
  });

  it("refuses the linear block and the linear continuation outside session events", () => {
    const base = configuration();
    assert.throws(
      () =>
        compileHubConfig({
          ...base,
          triggers: [
            {
              ...base.triggers[0]!,
              steps: [{ ...base.triggers[0]!.steps[0]!, linear: { on_start: "started" } }],
            },
          ],
        }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.deepEqual(Reflect.get(error, "path"), [
          "triggers",
          "run",
          "steps",
          "work",
          "linear",
        ]);
        assert.match(
          error.message,
          /trigger run step work linear is only available for linear\.agent_session_created and linear\.agent_session_prompted/u,
        );
        return true;
      },
    );
    assert.throws(
      () => parseCompiledHubConfig(withContinuation(compileHubConfig(base), "linear")),
      /active configuration contains an invalid compiled workflow contract/u,
    );
    const session = compileHubConfig({
      ...base,
      triggers: [sessionTrigger("linear.agent_session_prompted")],
    });
    assert.doesNotThrow(() => parseCompiledHubConfig(withContinuation(session, "linear")));
  });

  it("lets only session-only environments name their branch after the Linear issue", () => {
    const worktree = { mode: "branch-off", newBranch: "linear/${{ linear.issue.identifier }}" };
    const sessionOnly = {
      environments: [{ ...environment, worktree }],
      triggers: [
        sessionTrigger("linear.agent_session_created"),
        sessionTrigger("linear.agent_session_prompted"),
      ],
    };
    const compiled = compileHubConfig(sessionOnly);
    assert.equal(newBranchOf(compiled), "linear/${{ linear.issue.identifier }}");
    assert.deepEqual(parseCompiledHubConfig(structuredClone(compiled)), compiled);
    for (const intruder of [
      configuration().triggers[0]!,
      {
        ...configuration().triggers[0]!,
        inputs: { where: { type: "string", choices: ["runner"] } },
        steps: [
          { ...configuration().triggers[0]!.steps[0]!, environment: "${{ paseo.inputs.where }}" },
        ],
      },
    ]) {
      assert.throws(
        () => compileHubConfig({ ...sessionOnly, triggers: [...sessionOnly.triggers, intruder] }),
        (error) => {
          assert.ok(error instanceof Error);
          assert.deepEqual(Reflect.get(error, "path"), [
            "environments",
            "runner",
            "worktree",
            "newBranch",
          ]);
          assert.match(
            error.message,
            /environments\.runner\.worktree\.newBranch uses linear\.issue\.identifier but a non-Linear trigger targets this environment/u,
          );
          return true;
        },
      );
    }
  });

  it("keeps linear.issue out of conditions and values, but lets a prompt name the session", () => {
    const trigger = sessionTrigger("linear.agent_session_created");
    const step = trigger.steps[0]!;
    // An agent that reads Linear itself needs the two handles, and nothing else restated.
    compileHubConfig({
      ...configuration(),
      triggers: [
        {
          ...trigger,
          steps: [
            {
              ...step,
              prompt: [{ text: "${{ linear.issue.identifier }} ${{ linear.session.id }}" }],
            },
          ],
        },
      ],
    });
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            { ...trigger, steps: [{ ...step, if: "${{ linear.issue.identifier == 'X' }}" }] },
          ],
        }),
      /step work if uses linear\.issue outside environment worktree\.newBranch/u,
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            { ...trigger, values: { branch: "${{ linear.issue.identifier }}" }, steps: [step] },
          ],
        }),
      /value branch uses linear\.issue outside environment worktree\.newBranch/u,
    );
  });
});
