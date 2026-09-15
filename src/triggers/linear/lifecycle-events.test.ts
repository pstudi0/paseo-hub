import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { LINEAR_FIXTURE, readLinearFixture } from "../../test-utils/linear-fixtures.js";
import { parseLinearLifecycleEvent } from "./lifecycle-events.js";

describe("Linear lifecycle events", () => {
  it("parses a team access change", () => {
    const event = parseLinearLifecycleEvent(
      "PermissionChange",
      readLinearFixture("linear-permission-change"),
    );

    assert.deepEqual(event, {
      kind: "permission_change",
      type: "PermissionChange",
      action: "teamAccessChanged",
      organizationId: LINEAR_FIXTURE.organizationId,
      oauthClientId: LINEAR_FIXTURE.oauthClientId,
      appUserId: LINEAR_FIXTURE.appUserId,
      canAccessAllPublicTeams: false,
      addedTeamIds: [LINEAR_FIXTURE.teamId],
      removedTeamIds: [],
      webhookId: LINEAR_FIXTURE.webhookId,
      createdAt: "2026-09-15T11:00:00.000Z",
    });
  });

  it("parses a de-authorization", () => {
    const event = parseLinearLifecycleEvent(
      "OAuthApp",
      readLinearFixture("linear-oauth-app-revoked"),
    );

    assert.deepEqual(event, {
      kind: "revoked",
      type: "OAuthApp",
      action: "revoked",
      organizationId: LINEAR_FIXTURE.organizationId,
      oauthClientId: LINEAR_FIXTURE.oauthClientId,
      webhookId: LINEAR_FIXTURE.webhookId,
      createdAt: "2026-09-15T11:05:00.000Z",
    });
  });

  it("parses an inbox notification and keeps its unknown fields", () => {
    const event = parseLinearLifecycleEvent(
      null,
      readLinearFixture("linear-app-user-notification-unassigned"),
    );
    if (event?.kind !== "notification") throw new Error("expected a notification");

    assert.equal(event.action, "issueUnassignedFromYou");
    assert.equal(event.appUserId, LINEAR_FIXTURE.appUserId);
    assert.equal(event.notification.issueId, LINEAR_FIXTURE.issueId);
    assert.equal(event.notification.actorId, LINEAR_FIXTURE.humanId);
    assert.equal((event.notification as Record<string, unknown>)["type"], "issueUnassignedFromYou");
  });

  it("ignores OAuthApp deliveries other than revoked", () => {
    const payload = readLinearFixture("linear-oauth-app-revoked");
    payload["action"] = "authorized";

    assert.equal(parseLinearLifecycleEvent("OAuthApp", payload), undefined);
  });

  it("ignores every other delivery, including agent sessions and malformed bodies", () => {
    assert.equal(
      parseLinearLifecycleEvent(
        "AgentSessionEvent",
        readLinearFixture("linear-agent-session-created"),
      ),
      undefined,
    );
    assert.equal(
      parseLinearLifecycleEvent("PermissionChange", { type: "PermissionChange" }),
      undefined,
    );
    assert.equal(parseLinearLifecycleEvent(null, "PermissionChange"), undefined);
  });
});
