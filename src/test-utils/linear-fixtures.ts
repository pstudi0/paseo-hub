import { readFileSync } from "node:fs";

/**
 * Webhook bodies under `src/triggers/fixtures/`, conformant to Linear's agent-session and
 * lifecycle payloads. Each read is a fresh copy so a test can mutate its own delivery.
 */
export type LinearFixtureName =
  | "linear-agent-session-created"
  | "linear-agent-session-created-mention"
  | "linear-agent-session-created-automation"
  | "linear-agent-session-prompted"
  | "linear-agent-session-stop"
  | "linear-permission-change"
  | "linear-oauth-app-revoked"
  | "linear-app-user-notification-unassigned";

/** The identifiers the fixtures share, for assertions and trigger filters. */
export const LINEAR_FIXTURE = {
  organizationId: "6f1e7b2a-1b6e-4c47-9d2c-0d0d0d0d0d00",
  teamId: "6f1e7b2a-1b6e-4c47-9d2c-0d0d0d0d0d01",
  appUserId: "6f1e7b2a-1b6e-4c47-9d2c-0d0d0d0d0d02",
  oauthClientId: "6f1e7b2a-1b6e-4c47-9d2c-0d0d0d0d0d03",
  humanId: "6f1e7b2a-1b6e-4c47-9d2c-0d0d0d0d0d10",
  otherHumanId: "6f1e7b2a-1b6e-4c47-9d2c-0d0d0d0d0d11",
  issueId: "6f1e7b2a-1b6e-4c47-9d2c-0d0d0d0d0d20",
  sessionId: "6f1e7b2a-1b6e-4c47-9d2c-0d0d0d0d0d30",
  mentionSessionId: "6f1e7b2a-1b6e-4c47-9d2c-0d0d0d0d0d31",
  automationSessionId: "6f1e7b2a-1b6e-4c47-9d2c-0d0d0d0d0d32",
  rootCommentId: "6f1e7b2a-1b6e-4c47-9d2c-0d0d0d0d0d40",
  mentionCommentId: "6f1e7b2a-1b6e-4c47-9d2c-0d0d0d0d0d41",
  previousCommentId: "6f1e7b2a-1b6e-4c47-9d2c-0d0d0d0d0d42",
  promptActivityId: "6f1e7b2a-1b6e-4c47-9d2c-0d0d0d0d0d50",
  stopActivityId: "6f1e7b2a-1b6e-4c47-9d2c-0d0d0d0d0d51",
  webhookId: "6f1e7b2a-1b6e-4c47-9d2c-0d0d0d0d0d60",
} as const;

export function readLinearFixture(name: LinearFixtureName): Record<string, unknown> {
  const url = new URL(`../triggers/fixtures/${name}.json`, import.meta.url);
  return fixtureRecord(JSON.parse(readFileSync(url, "utf8")));
}

/** A nested object of a fixture, for tests that alter one delivery before normalizing it. */
export function fixtureRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected a fixture object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
