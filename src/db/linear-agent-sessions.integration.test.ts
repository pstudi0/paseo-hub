import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createDatabase, createPostgresQueryRuntime } from "./test-utils/runtime.js";
import { linearConnectionRequiresReauthorization } from "../providers/linear/client.js";
import type { AgentSessionRecord } from "../agent-sessions/types.js";
import type { Database, LinearPendingPermission, UpsertLinearAgentSessionInput } from "./types.js";

const ORGANIZATION_ID = "linear-sessions-org";
const PROJECT_ID = "50000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "50000000-0000-4000-8000-000000000002";
const LINEAR_ORGANIZATION_ID = "linear-sessions-workspace";
const START_ACCESS = {
  sessionId: "linear-sessions-session",
  userId: "linear-sessions-operator",
  membershipId: "linear-sessions-member",
  organizationId: ORGANIZATION_ID,
  returnRoute: "/",
};

describe("Linear agent session PostgreSQL repository", () => {
  let postgres: StartedPostgreSqlContainer;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  }, 120_000);

  it("registers a session once per Linear session id", async () => {
    const fixture = await sessionFixture(postgres);
    try {
      const first = await fixture.database.upsertLinearAgentSession(sessionInput("linear-1"));
      assert.equal(first.created, true);
      assert.deepEqual(first.record, {
        ...first.record,
        organizationId: ORGANIZATION_ID,
        linearConnectionId: CONNECTION_ID,
        linearOrganizationId: LINEAR_ORGANIZATION_ID,
        linearSessionId: "linear-1",
        issueId: "issue-1",
        issueIdentifier: "ENG-42",
        teamId: "team-1",
        projectId: null,
        agentSessionId: null,
        currentExecutionId: null,
        mirrorStatus: "pending",
        pendingPermission: null,
        pendingPrompts: [],
      });
      assert.ok(first.record.createdAt instanceof Date);

      await fixture.database.updateLinearAgentSession("linear-1", { mirrorStatus: "active" });
      const replay = await fixture.database.upsertLinearAgentSession(
        sessionInput("linear-1", { issueIdentifier: "ENG-99", teamId: "team-other" }),
      );
      assert.equal(replay.created, false);
      assert.equal(replay.record.id, first.record.id);
      assert.equal(replay.record.issueIdentifier, "ENG-42");
      assert.equal(replay.record.mirrorStatus, "active");

      await assert.rejects(
        fixture.client.query(
          `insert into linear_agent_sessions
             (organization_id, linear_connection_id, linear_organization_id, linear_session_id,
              issue_id, team_id)
           values ($1, $2, $3, 'linear-1', 'issue-1', 'team-1')`,
          [ORGANIZATION_ID, CONNECTION_ID, LINEAR_ORGANIZATION_ID],
        ),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "constraint" in error &&
          error.constraint === "linear_agent_sessions_linear_session_unique",
      );
      await assert.rejects(
        fixture.client.query(
          `update linear_agent_sessions set mirror_status = 'unknown' where linear_session_id = 'linear-1'`,
        ),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "constraint" in error &&
          error.constraint === "linear_agent_sessions_mirror_status_check",
      );
    } finally {
      await fixture.close();
    }
  });

  it("lists the sessions of one issue most recently created first", async () => {
    const fixture = await sessionFixture(postgres);
    try {
      await fixture.database.upsertLinearAgentSession(sessionInput("linear-1"));
      await fixture.database.upsertLinearAgentSession(sessionInput("linear-2"));
      await fixture.database.upsertLinearAgentSession(
        sessionInput("linear-other-issue", { issueId: "issue-2" }),
      );

      assert.deepEqual(
        (
          await fixture.database.listLinearAgentSessionsForIssue(LINEAR_ORGANIZATION_ID, "issue-1")
        ).map((session) => session.linearSessionId),
        ["linear-2", "linear-1"],
      );
      assert.deepEqual(
        await fixture.database.listLinearAgentSessionsForIssue("linear-unknown", "issue-1"),
        [],
      );
    } finally {
      await fixture.close();
    }
  });

  it("applies partial patches where an absent key is unchanged and null clears", async () => {
    const fixture = await sessionFixture(postgres);
    try {
      await fixture.database.upsertLinearAgentSession(sessionInput("linear-1"));
      await fixture.database.saveAgentSession(agentSession("60000000-0000-4000-8000-000000000001"));
      const permission: LinearPendingPermission = {
        requestId: "permission-1",
        agentId: "agent-1",
        executionId: "execution-1",
        activityId: "activity-1",
        options: [
          { value: "allow", label: "Allow", behavior: "allow", selectedActionId: "action-1" },
          { value: "deny", label: "Deny", behavior: "deny", forSession: true },
        ],
        suggestions: [{ kind: "allow_once" }],
      };

      const bound = await fixture.database.updateLinearAgentSession("linear-1", {
        projectId: PROJECT_ID,
        agentSessionId: "60000000-0000-4000-8000-000000000001",
        daemonId: "60000000-0000-4000-8000-000000000030",
        daemonAgentId: "agent-1",
        daemonWorkspaceId: "workspace-1",
        mirrorStatus: "awaitingInput",
        respondedAt: new Date(5_000),
        lastActivityId: "activity-1",
        lastActivityAt: new Date(6_000),
        lastAssistantMessage: "Working on it",
        pullRequestUrl: "https://github.com/acme/hub/pull/1",
        pendingPermission: permission,
        stopRequestedAt: new Date(7_000),
      });
      assert.ok(bound);
      assert.deepEqual(bound.pendingPermission, permission);
      assert.ok(bound.updatedAt.getTime() >= bound.createdAt.getTime());

      const cleared = await fixture.database.updateLinearAgentSession("linear-1", {
        pendingPermission: null,
        stopRequestedAt: null,
        lastAssistantMessage: null,
      });
      assert.ok(cleared);
      assert.deepEqual(
        {
          projectId: cleared.projectId,
          agentSessionId: cleared.agentSessionId,
          daemonId: cleared.daemonId,
          daemonAgentId: cleared.daemonAgentId,
          daemonWorkspaceId: cleared.daemonWorkspaceId,
          mirrorStatus: cleared.mirrorStatus,
          respondedAt: cleared.respondedAt,
          lastActivityId: cleared.lastActivityId,
          lastActivityAt: cleared.lastActivityAt,
          lastAssistantMessage: cleared.lastAssistantMessage,
          pullRequestUrl: cleared.pullRequestUrl,
          pendingPermission: cleared.pendingPermission,
          stopRequestedAt: cleared.stopRequestedAt,
        },
        {
          projectId: PROJECT_ID,
          agentSessionId: "60000000-0000-4000-8000-000000000001",
          daemonId: "60000000-0000-4000-8000-000000000030",
          daemonAgentId: "agent-1",
          daemonWorkspaceId: "workspace-1",
          mirrorStatus: "awaitingInput",
          respondedAt: new Date(5_000),
          lastActivityId: "activity-1",
          lastActivityAt: new Date(6_000),
          lastAssistantMessage: null,
          pullRequestUrl: "https://github.com/acme/hub/pull/1",
          pendingPermission: null,
          stopRequestedAt: null,
        },
      );
      assert.deepEqual(await fixture.database.findLinearAgentSession("linear-1"), cleared);
      assert.equal(
        await fixture.database.updateLinearAgentSession("missing", { mirrorStatus: "error" }),
        undefined,
      );
    } finally {
      await fixture.close();
    }
  });

  it("hands queued prompts out exactly once under concurrent takers", async () => {
    const fixture = await sessionFixture(postgres);
    try {
      await fixture.database.upsertLinearAgentSession(sessionInput("linear-1"));
      const prompts = Array.from({ length: 4 }, (_, index) => ({
        activityId: `activity-${index}`,
        body: `Prompt ${index}`,
        receivedAt: new Date(index * 1_000).toISOString(),
      }));
      for (const prompt of prompts) {
        await fixture.database.appendLinearPendingPrompt("linear-1", prompt);
      }
      assert.deepEqual(
        (await fixture.database.findLinearAgentSession("linear-1"))?.pendingPrompts,
        prompts,
      );

      const takes = await Promise.all(
        Array.from({ length: 3 }, () => fixture.database.takeLinearPendingPrompts("linear-1")),
      );
      assert.deepEqual(takes.flat(), prompts);
      assert.equal(takes.filter((taken) => taken.length > 0).length, 1);
      assert.deepEqual(
        (await fixture.database.findLinearAgentSession("linear-1"))?.pendingPrompts,
        [],
      );
      assert.deepEqual(await fixture.database.takeLinearPendingPrompts("missing"), []);
      assert.equal(
        await fixture.database.appendLinearPendingPrompt("missing", prompts[0]!),
        undefined,
      );
    } finally {
      await fixture.close();
    }
  });

  it("finds sessions by workspace key newest first and reads legacy rows as null", async () => {
    const fixture = await sessionFixture(postgres);
    try {
      await fixture.database.saveAgentSession(agentSession("60000000-0000-4000-8000-000000000001"));
      await fixture.database.saveAgentSession(agentSession("60000000-0000-4000-8000-000000000002"));
      await fixture.database.saveAgentSession(
        agentSession("60000000-0000-4000-8000-000000000003", {
          workspaceKey: "linear:issue:issue-2",
        }),
      );
      await fixture.database.saveAgentSession(
        agentSession("60000000-0000-4000-8000-000000000001", { agentId: "agent-1" }),
      );
      const legacy = agentSession("60000000-0000-4000-8000-000000000004", {
        continuationKey: "legacy",
      });
      delete (legacy as Partial<AgentSessionRecord>).workspaceKey;
      await fixture.client.query(
        `insert into agent_sessions (id, organization_id, project_id, continuation_key, data)
         values ($1, $2, $3, 'legacy', $4)`,
        [legacy.id, ORGANIZATION_ID, PROJECT_ID, legacy],
      );

      assert.deepEqual(
        (
          await fixture.database.findAgentSessionsByWorkspaceKey(PROJECT_ID, "linear:issue:issue-1")
        ).map((session) => [session.id, session.agentId]),
        [
          ["60000000-0000-4000-8000-000000000002", null],
          ["60000000-0000-4000-8000-000000000001", "agent-1"],
        ],
      );
      assert.deepEqual(await fixture.database.findAgentSessionsByWorkspaceKey(PROJECT_ID, "x"), []);
      assert.equal((await fixture.database.findAgentSession(legacy.id))?.workspaceKey, null);
      assert.equal(
        (await fixture.database.findAgentSessionByKey(PROJECT_ID, "legacy"))?.workspaceKey,
        null,
      );
      const indexed = await fixture.client.query<{ workspace_key: string | null }>(
        "select workspace_key from agent_sessions where id = $1",
        ["60000000-0000-4000-8000-000000000001"],
      );
      assert.equal(indexed.rows[0]?.workspace_key, "linear:issue:issue-1");
    } finally {
      await fixture.close();
    }
  });

  it("erases the mirror when the Linear connection is disconnected", async () => {
    const fixture = await sessionFixture(postgres);
    try {
      await fixture.database.upsertLinearAgentSession(sessionInput("linear-1"));

      const disconnected = await fixture.database.disconnectConnection(
        "linear",
        CONNECTION_ID,
        START_ACCESS,
      );
      assert.deepEqual(disconnected, {
        provider: "linear",
        linearOrganizationId: LINEAR_ORGANIZATION_ID,
        accessToken: "linear-access-token",
        refreshToken: "linear-refresh-token",
      });
      assert.equal(await fixture.database.findLinearAgentSession("linear-1"), undefined);
      assert.deepEqual(
        await fixture.database.listLinearAgentSessionsForIssue(LINEAR_ORGANIZATION_ID, "issue-1"),
        [],
      );
    } finally {
      await fixture.close();
    }
  });

  it("claims lifecycle receipts once and applies revocation and team access", async () => {
    const fixture = await sessionFixture(postgres);
    try {
      const claim = await fixture.database.claimLinearLifecycleReceipt(
        lifecycleInput("lifecycle-1"),
      );
      assert.equal(claim.status, "claimed");
      if (claim.status !== "claimed") return;
      assert.deepEqual(claim, {
        status: "claimed",
        providerEventReceiptId: claim.providerEventReceiptId,
        connectionId: CONNECTION_ID,
        organizationId: ORGANIZATION_ID,
        linearOrganizationId: LINEAR_ORGANIZATION_ID,
      });
      assert.equal(
        (
          await fixture.database.findProviderEventReceiptByDeliveryId(
            "lifecycle-1",
            ORGANIZATION_ID,
          )
        )?.droppedReason,
        "linear_lifecycle",
      );
      assert.deepEqual(
        await fixture.database.claimLinearLifecycleReceipt(lifecycleInput("lifecycle-1")),
        { status: "duplicate", providerEventReceiptId: claim.providerEventReceiptId },
      );
      assert.deepEqual(
        await fixture.database.claimLinearLifecycleReceipt(
          lifecycleInput("lifecycle-2", "linear-unknown"),
        ),
        { status: "unbound" },
      );

      const teamAccess = {
        canAccessAllPublicTeams: false,
        teamIds: ["team-1", "team-2"],
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      await fixture.database.applyLinearLifecycle(claim, { kind: "team_access", teamAccess });
      assert.deepEqual(
        (await fixture.database.findLinearConnection(LINEAR_ORGANIZATION_ID))?.teamAccess,
        teamAccess,
      );
      assert.deepEqual(
        (await fixture.database.organizationConnectionUsage(ORGANIZATION_ID)).linear.map(
          (connection) => connection.teamAccess,
        ),
        [teamAccess],
      );

      const before = await fixture.database.findLinearConnection(LINEAR_ORGANIZATION_ID);
      assert.ok(before);
      assert.equal(linearConnectionRequiresReauthorization(before), false);
      await fixture.database.applyLinearLifecycle(claim, { kind: "revoked" });
      const revoked = await fixture.database.findLinearConnection(LINEAR_ORGANIZATION_ID);
      assert.ok(revoked);
      assert.equal(revoked.refreshToken, null);
      assert.deepEqual(revoked.accessTokenExpiresAt, new Date(0));
      assert.equal(linearConnectionRequiresReauthorization(revoked, new Date(1)), true);

      await fixture.database.releaseLinearLifecycleReceipt(claim.providerEventReceiptId);
      assert.equal(
        await fixture.database.findProviderEventReceiptByDeliveryId("lifecycle-1", ORGANIZATION_ID),
        undefined,
      );
      // A released claim no longer authorizes a mutation.
      await fixture.client.query(
        `update linear_connections set refresh_token = 'restored' where id = $1`,
        [CONNECTION_ID],
      );
      await fixture.database.applyLinearLifecycle(claim, { kind: "revoked" });
      assert.equal(
        (await fixture.database.findLinearConnection(LINEAR_ORGANIZATION_ID))?.refreshToken,
        "restored",
      );

      assert.equal(await fixture.database.findOrganizationSlug(ORGANIZATION_ID), "linear-sessions");
      assert.equal(await fixture.database.findOrganizationSlug("unknown"), undefined);
    } finally {
      await fixture.close();
    }
  });
});

function sessionInput(
  linearSessionId: string,
  overrides: Partial<UpsertLinearAgentSessionInput> = {},
): UpsertLinearAgentSessionInput {
  return {
    organizationId: ORGANIZATION_ID,
    linearConnectionId: CONNECTION_ID,
    linearOrganizationId: LINEAR_ORGANIZATION_ID,
    linearSessionId,
    issueId: "issue-1",
    issueIdentifier: "ENG-42",
    teamId: "team-1",
    ...overrides,
  };
}

function agentSession(id: string, overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    id,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    continuationKey: `linear:session:${id}`,
    workspaceKey: "linear:issue:issue-1",
    workspaceResolution: null,
    daemonId: "daemon-1",
    agentId: null,
    workspaceId: null,
    compatibility: "test",
    creationOptions: {
      provider: "codex",
      cwd: "/workspace",
      env: {},
      toolPolicy: { preapproved: [] },
    },
    capabilityTokenHash: "test",
    tools: [],
    ...overrides,
  };
}

function lifecycleInput(deliveryId: string, linearOrganizationId = LINEAR_ORGANIZATION_ID) {
  return {
    linearOrganizationId,
    deliveryId,
    signatureHash: `signature-${deliveryId}`,
    source: "linear.permission_change",
    payload: { action: "PermissionChange" },
    receivedAt: new Date(0),
  };
}

async function sessionFixture(postgres: StartedPostgreSqlContainer): Promise<{
  database: Database;
  client: Awaited<ReturnType<typeof createPostgresQueryRuntime>>;
  close(): Promise<void>;
}> {
  const url = new URL(postgres.getConnectionUri());
  url.pathname = `/linear_sessions_${randomUUID().replaceAll("-", "")}`;
  const database = await createDatabase(url.toString());
  const client = await createPostgresQueryRuntime(url.toString());
  await client.query(`
    insert into "user" (id, name, email, email_verified, created_at, updated_at,
                        must_change_password, is_instance_operator)
    values ('${START_ACCESS.userId}', 'Operator', 'linear-sessions@example.test', true, now(),
            now(), false, true);
    insert into organization (id, name, slug)
    values ('${ORGANIZATION_ID}', 'Linear Sessions', 'linear-sessions');
    insert into session (id, token, user_id, active_organization_id, expires_at)
    values ('${START_ACCESS.sessionId}', 'linear-sessions-token', '${START_ACCESS.userId}',
            '${ORGANIZATION_ID}', now() + interval '1 hour');
    insert into member (id, organization_id, user_id, role)
    values ('${START_ACCESS.membershipId}', '${ORGANIZATION_ID}', '${START_ACCESS.userId}',
            'owner');
    insert into projects (id, organization_id, name, slug)
    values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Default', 'default');
    insert into linear_connections
      (id, organization_id, linear_organization_id, provider_application_id, slug,
       linear_organization_name, app_user_id, access_token, refresh_token, scopes)
    values
      ('${CONNECTION_ID}', '${ORGANIZATION_ID}', '${LINEAR_ORGANIZATION_ID}', 'linear-app',
       'linear-sessions', 'Linear Sessions', 'linear-app-user', 'linear-access-token',
       'linear-refresh-token', '["read", "comments:create"]'::jsonb);
  `);
  return {
    database,
    client,
    async close() {
      await client.close();
      await database.close();
    },
  };
}
