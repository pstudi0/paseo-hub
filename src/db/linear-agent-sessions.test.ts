import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "./memory.js";
import { linearConnectionRequiresReauthorization } from "../providers/linear/client.js";
import type { AgentSessionRecord } from "../agent-sessions/types.js";
import type {
  LinearConnectionRecord,
  LinearPendingPermission,
  UpsertLinearAgentSessionInput,
} from "./types.js";

const ORGANIZATION_ID = "org-1";
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";

const connection: LinearConnectionRecord = {
  id: "00000000-0000-4000-8000-000000000003",
  organizationId: ORGANIZATION_ID,
  slug: "acme-linear",
  providerApplicationId: "linear-app",
  linearOrganizationId: "linear-org",
  linearOrganizationName: "Acme",
  appUserId: "app-user",
  accessToken: "access-token",
  refreshToken: "refresh-token",
  accessTokenExpiresAt: null,
  scopes: ["read", "write", "comments:create", "app:assignable", "app:mentionable"],
  teamAccess: null,
};

function sessionInput(
  linearSessionId: string,
  overrides: Partial<UpsertLinearAgentSessionInput> = {},
): UpsertLinearAgentSessionInput {
  return {
    organizationId: ORGANIZATION_ID,
    linearConnectionId: connection.id,
    linearOrganizationId: connection.linearOrganizationId,
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

describe("Linear agent sessions (memory database)", () => {
  it("registers a session once and replays the existing row on a repeated created webhook", async () => {
    const database = createMemoryDatabase({ now: () => new Date(1_000) });

    const first = await database.upsertLinearAgentSession(sessionInput("linear-session-1"));
    assert.equal(first.created, true);
    assert.deepEqual(first.record, {
      id: first.record.id,
      organizationId: ORGANIZATION_ID,
      linearConnectionId: connection.id,
      linearOrganizationId: "linear-org",
      linearSessionId: "linear-session-1",
      issueId: "issue-1",
      issueIdentifier: "ENG-42",
      teamId: "team-1",
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
      createdAt: new Date(1_000),
      updatedAt: new Date(1_000),
    });

    await database.updateLinearAgentSession("linear-session-1", { mirrorStatus: "active" });
    const replay = await database.upsertLinearAgentSession(
      sessionInput("linear-session-1", { issueIdentifier: "ENG-99", teamId: "team-other" }),
    );
    assert.equal(replay.created, false);
    assert.equal(replay.record.id, first.record.id);
    assert.equal(replay.record.issueIdentifier, "ENG-42");
    assert.equal(replay.record.teamId, "team-1");
    assert.equal(replay.record.mirrorStatus, "active");
    assert.deepEqual(await database.findLinearAgentSession("linear-session-1"), replay.record);
    assert.equal(await database.findLinearAgentSession("linear-session-unknown"), undefined);
  });

  it("lists the sessions of one issue, most recently created first", async () => {
    let tick = 0;
    const database = createMemoryDatabase({ now: () => new Date(++tick * 1_000) });
    await database.upsertLinearAgentSession(sessionInput("linear-session-1"));
    await database.upsertLinearAgentSession(sessionInput("linear-session-2"));
    await database.upsertLinearAgentSession(
      sessionInput("linear-session-other-issue", { issueId: "issue-2" }),
    );
    await database.upsertLinearAgentSession(
      sessionInput("linear-session-other-workspace", { linearOrganizationId: "linear-org-2" }),
    );

    assert.deepEqual(
      (await database.listLinearAgentSessionsForIssue("linear-org", "issue-1")).map(
        (session) => session.linearSessionId,
      ),
      ["linear-session-2", "linear-session-1"],
    );
    assert.deepEqual(await database.listLinearAgentSessionsForIssue("linear-org", "issue-3"), []);
  });

  it("applies partial patches where an absent key is unchanged and null clears", async () => {
    let tick = 0;
    const database = createMemoryDatabase({ now: () => new Date(++tick * 1_000) });
    await database.upsertLinearAgentSession(sessionInput("linear-session-1"));

    const bound = await database.updateLinearAgentSession("linear-session-1", {
      projectId: PROJECT_ID,
      agentSessionId: "00000000-0000-4000-8000-000000000010",
      currentExecutionId: "00000000-0000-4000-8000-000000000020",
      daemonId: "00000000-0000-4000-8000-000000000030",
      daemonAgentId: "agent-1",
      daemonWorkspaceId: "workspace-1",
      mirrorStatus: "active",
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
    assert.equal(bound.mirrorStatus, "active");
    assert.equal(bound.updatedAt.getTime(), 2_000);

    const cleared = await database.updateLinearAgentSession("linear-session-1", {
      currentExecutionId: null,
      pendingPermission: null,
      stopRequestedAt: null,
      lastAssistantMessage: null,
    });
    assert.ok(cleared);
    assert.deepEqual(
      {
        projectId: cleared.projectId,
        agentSessionId: cleared.agentSessionId,
        currentExecutionId: cleared.currentExecutionId,
        daemonAgentId: cleared.daemonAgentId,
        daemonWorkspaceId: cleared.daemonWorkspaceId,
        mirrorStatus: cleared.mirrorStatus,
        respondedAt: cleared.respondedAt,
        lastActivityId: cleared.lastActivityId,
        lastAssistantMessage: cleared.lastAssistantMessage,
        pullRequestUrl: cleared.pullRequestUrl,
        pendingPermission: cleared.pendingPermission,
        stopRequestedAt: cleared.stopRequestedAt,
        createdAt: cleared.createdAt,
        updatedAt: cleared.updatedAt,
      },
      {
        projectId: PROJECT_ID,
        agentSessionId: "00000000-0000-4000-8000-000000000010",
        currentExecutionId: null,
        daemonAgentId: "agent-1",
        daemonWorkspaceId: "workspace-1",
        mirrorStatus: "active",
        respondedAt: new Date(5_000),
        lastActivityId: "activity-1",
        lastAssistantMessage: null,
        pullRequestUrl: "https://github.com/acme/hub/pull/1",
        pendingPermission: null,
        stopRequestedAt: null,
        createdAt: new Date(1_000),
        updatedAt: new Date(3_000),
      },
    );
    assert.equal(
      await database.updateLinearAgentSession("missing", { mirrorStatus: "error" }),
      undefined,
    );
  });

  it("returns clones so callers cannot mutate the stored record", async () => {
    const database = createMemoryDatabase();
    await database.upsertLinearAgentSession(sessionInput("linear-session-1"));
    await database.updateLinearAgentSession("linear-session-1", { pendingPermission: permission });

    const read = await database.findLinearAgentSession("linear-session-1");
    assert.ok(read?.pendingPermission);
    Object.assign(read.pendingPermission, { requestId: "tampered" });
    assert.equal(
      (await database.findLinearAgentSession("linear-session-1"))?.pendingPermission?.requestId,
      "permission-1",
    );
  });

  it("queues prompts in order and hands them out exactly once", async () => {
    const database = createMemoryDatabase();
    await database.upsertLinearAgentSession(sessionInput("linear-session-1"));

    const first = await database.appendLinearPendingPrompt("linear-session-1", {
      activityId: "activity-1",
      body: "First",
      receivedAt: "2026-01-01T00:00:00.000Z",
    });
    const second = await database.appendLinearPendingPrompt("linear-session-1", {
      activityId: "activity-2",
      body: "Second",
      receivedAt: "2026-01-01T00:00:01.000Z",
    });
    assert.equal(first?.pendingPrompts.length, 1);
    assert.deepEqual(
      second?.pendingPrompts.map((prompt) => prompt.activityId),
      ["activity-1", "activity-2"],
    );
    assert.equal(
      await database.appendLinearPendingPrompt("missing", {
        activityId: "activity-3",
        body: "Third",
        receivedAt: "2026-01-01T00:00:02.000Z",
      }),
      undefined,
    );

    const [taken, concurrent] = await Promise.all([
      database.takeLinearPendingPrompts("linear-session-1"),
      database.takeLinearPendingPrompts("linear-session-1"),
    ]);
    assert.deepEqual(
      [...taken, ...concurrent].map((prompt) => prompt.activityId),
      ["activity-1", "activity-2"],
    );
    assert.deepEqual(await database.takeLinearPendingPrompts("linear-session-1"), []);
    assert.deepEqual(
      (await database.findLinearAgentSession("linear-session-1"))?.pendingPrompts,
      [],
    );
    assert.deepEqual(await database.takeLinearPendingPrompts("missing"), []);
  });
});

describe("agent session workspace keys (memory database)", () => {
  it("finds the sessions sharing a workspace key, most recently saved first", async () => {
    const database = createMemoryDatabase();
    await database.saveAgentSession(agentSession("session-1"));
    await database.saveAgentSession(agentSession("session-2"));
    await database.saveAgentSession(
      agentSession("session-3", { workspaceKey: "linear:issue:issue-2" }),
    );
    await database.saveAgentSession(
      agentSession("session-4", { projectId: "00000000-0000-4000-8000-000000000002" }),
    );
    await database.saveAgentSession(agentSession("session-1", { agentId: "agent-1" }));

    assert.deepEqual(
      (await database.findAgentSessionsByWorkspaceKey(PROJECT_ID, "linear:issue:issue-1")).map(
        (session) => [session.id, session.agentId],
      ),
      [
        ["session-2", null],
        ["session-1", "agent-1"],
      ],
    );
    assert.deepEqual(await database.findAgentSessionsByWorkspaceKey(PROJECT_ID, "unknown"), []);
  });

  it("reads sessions persisted before the workspace key existed as null", async () => {
    const database = createMemoryDatabase();
    const legacy = agentSession("session-legacy", { workspaceKey: null });
    delete (legacy as Partial<AgentSessionRecord>).workspaceKey;
    await database.saveAgentSession(legacy);

    assert.equal((await database.findAgentSession("session-legacy"))?.workspaceKey, null);
    assert.equal(
      (await database.findAgentSessionByKey(PROJECT_ID, "linear:session:session-legacy"))
        ?.workspaceKey,
      null,
    );
  });
});

describe("Linear lifecycle receipts (memory database)", () => {
  function lifecycleInput(deliveryId: string, linearOrganizationId = "linear-org") {
    return {
      linearOrganizationId,
      deliveryId,
      signatureHash: `signature-${deliveryId}`,
      source: "linear.permission_change",
      payload: { action: "PermissionChange" },
      receivedAt: new Date(0),
    };
  }

  it("seeds Linear connections and claims one receipt per delivery", async () => {
    const database = createMemoryDatabase({ linearConnections: [connection] });
    assert.deepEqual(await database.findLinearConnection("linear-org"), connection);
    assert.deepEqual(
      await database.findLinearConnectionForOrganization(ORGANIZATION_ID, "linear-org"),
      connection,
    );

    const claim = await database.claimLinearLifecycleReceipt(lifecycleInput("delivery-1"));
    assert.equal(claim.status, "claimed");
    if (claim.status !== "claimed") return;
    assert.deepEqual(claim, {
      status: "claimed",
      providerEventReceiptId: claim.providerEventReceiptId,
      connectionId: connection.id,
      organizationId: ORGANIZATION_ID,
      linearOrganizationId: "linear-org",
    });
    assert.equal(
      (await database.findProviderEventReceiptByDeliveryId("delivery-1", ORGANIZATION_ID))
        ?.droppedReason,
      "linear_lifecycle",
    );
    assert.deepEqual(await database.claimLinearLifecycleReceipt(lifecycleInput("delivery-1")), {
      status: "duplicate",
      providerEventReceiptId: claim.providerEventReceiptId,
    });
    assert.deepEqual(
      await database.claimLinearLifecycleReceipt(lifecycleInput("delivery-2", "linear-unknown")),
      { status: "unbound" },
    );

    await database.releaseLinearLifecycleReceipt(claim.providerEventReceiptId);
    assert.equal(
      await database.findProviderEventReceiptByDeliveryId("delivery-1", ORGANIZATION_ID),
      undefined,
    );
    const reclaimed = await database.claimLinearLifecycleReceipt(lifecycleInput("delivery-1"));
    assert.equal(reclaimed.status, "claimed");
  });

  it("revokes the connection credentials so the connection requires reauthorization", async () => {
    const database = createMemoryDatabase({ linearConnections: [connection] });
    const claim = await database.claimLinearLifecycleReceipt(lifecycleInput("delivery-revoked"));
    if (claim.status !== "claimed") throw new Error("expected a claimed receipt");
    assert.equal(linearConnectionRequiresReauthorization(connection), false);

    await database.applyLinearLifecycle(claim, { kind: "revoked" });

    const revoked = await database.findLinearConnection("linear-org");
    assert.ok(revoked);
    assert.equal(revoked.refreshToken, null);
    assert.deepEqual(revoked.accessTokenExpiresAt, new Date(0));
    assert.equal(linearConnectionRequiresReauthorization(revoked, new Date(1)), true);
  });

  it("stores team access and ignores noop or unclaimed results", async () => {
    const database = createMemoryDatabase({ linearConnections: [connection] });
    const claim = await database.claimLinearLifecycleReceipt(lifecycleInput("delivery-teams"));
    if (claim.status !== "claimed") throw new Error("expected a claimed receipt");
    const teamAccess = {
      canAccessAllPublicTeams: false,
      teamIds: ["team-1", "team-2"],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    await database.applyLinearLifecycle(claim, { kind: "team_access", teamAccess });
    assert.deepEqual((await database.findLinearConnection("linear-org"))?.teamAccess, teamAccess);

    await database.applyLinearLifecycle(claim, { kind: "noop" });
    assert.deepEqual((await database.findLinearConnection("linear-org"))?.teamAccess, teamAccess);

    await database.releaseLinearLifecycleReceipt(claim.providerEventReceiptId);
    await database.applyLinearLifecycle(claim, { kind: "revoked" });
    assert.equal(
      (await database.findLinearConnection("linear-org"))?.refreshToken,
      "refresh-token",
    );
  });
});

describe("organization slugs (memory database)", () => {
  it("resolves the slug of a known organization", async () => {
    const database = createMemoryDatabase({
      memberships: [
        {
          userId: "user-1",
          organizationId: ORGANIZATION_ID,
          organizationName: "Acme",
          organizationSlug: "acme",
          membershipId: "member-1",
          role: "owner",
        },
      ],
    });
    assert.equal(await database.findOrganizationSlug(ORGANIZATION_ID), "acme");
    assert.equal(await database.findOrganizationSlug("org-unknown"), undefined);
  });
});
