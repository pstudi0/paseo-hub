import assert from "node:assert/strict";
import { test } from "vitest";
import { ContinuationSchema, continuationKey, continuationWorkspaceKey } from "./continuation.js";

test("conversation policy uses opaque identity and events without a conversation get a new agent", () => {
  const render = () => {
    throw new Error("No expression expected");
  };
  assert.equal(
    continuationKey({ mode: "conversation" }, { key: "opaque", label: "Thread" }, render),
    "opaque",
  );
  assert.equal(continuationKey({ mode: "conversation" }, null, render), null);
  assert.equal(continuationKey({ mode: "new" }, { key: "opaque", label: "Thread" }, render), null);
});

test("custom keys render through the existing expression evaluator and reject empty or non-string results", () => {
  const policy = { mode: "key", key: "${{ paseo.inputs.ticket }}" } as const;
  assert.equal(
    continuationKey(policy, null, (template) => {
      assert.equal(template, policy.key);
      return "ticket-42";
    }),
    "custom:ticket-42",
  );
  for (const result of [undefined, null, 42, "  ", "x".repeat(513)]) {
    assert.throws(() => continuationKey(policy, null, () => result), /non-empty string/);
  }
});

test("the linear mode keys the agent by session and the workspace by issue, and nothing else has a workspace key", () => {
  const render = () => {
    throw new Error("No expression expected");
  };
  const conversation = {
    key: "linear:session:session-1",
    label: "Linear session",
    workspaceKey: "linear:issue:issue-1",
  };
  assert.equal(
    continuationKey({ mode: "linear" }, conversation, render),
    "linear:session:session-1",
  );
  assert.equal(continuationWorkspaceKey({ mode: "linear" }, conversation), "linear:issue:issue-1");
  assert.equal(continuationKey({ mode: "linear" }, null, render), null);
  assert.equal(continuationWorkspaceKey({ mode: "linear" }, null), null);
  assert.equal(
    continuationWorkspaceKey({ mode: "linear" }, { key: "opaque", label: "Thread" }),
    null,
  );
  for (const policy of [
    { mode: "conversation" } as const,
    { mode: "new" } as const,
    { mode: "key", key: "x" } as const,
  ]) {
    assert.equal(continuationWorkspaceKey(policy, conversation), null);
  }
  assert.equal(ContinuationSchema.safeParse({ mode: "linear" }).success, true);
  assert.equal(ContinuationSchema.safeParse({ mode: "linear", key: "x" }).success, false);
});
