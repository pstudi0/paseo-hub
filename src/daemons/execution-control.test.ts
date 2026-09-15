import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  createDeferredExecutionControl,
  ExecutionControlUnboundError,
  type ExecutionControl,
} from "./execution-control.js";

describe("deferred execution control", () => {
  it("fails loudly before a lifecycle is bound instead of pretending nothing is live", async () => {
    const control = createDeferredExecutionControl();
    await assert.rejects(
      () => control.steer("execution", "message", "text"),
      ExecutionControlUnboundError,
    );
    await assert.rejects(
      () => control.interrupt("execution", "reason"),
      ExecutionControlUnboundError,
    );
    await assert.rejects(
      () => control.respondToPermission("execution", "request", { behavior: "allow" }),
      ExecutionControlUnboundError,
    );
    await assert.rejects(
      () => control.readWorkspacePullRequest("execution"),
      ExecutionControlUnboundError,
    );
    await assert.rejects(() => control.daemonPermissions("daemon"), ExecutionControlUnboundError);
  });

  it("forwards every operation verbatim once bound", async () => {
    const calls: unknown[] = [];
    const bound: ExecutionControl = {
      steer: async (...args) => {
        calls.push(["steer", ...args]);
        return "sent";
      },
      interrupt: async (...args) => {
        calls.push(["interrupt", ...args]);
        return true;
      },
      respondToPermission: async (...args) => {
        calls.push(["respondToPermission", ...args]);
        return "resolved";
      },
      readWorkspacePullRequest: async (...args) => {
        calls.push(["readWorkspacePullRequest", ...args]);
        return { url: "https://github.com/acme/repo/pull/1", title: "PR" };
      },
      daemonPermissions: async (...args) => {
        calls.push(["daemonPermissions", ...args]);
        return ["hub.execute", "workspace.write"];
      },
    };
    const control = createDeferredExecutionControl();
    control.bind(bound);

    assert.equal(await control.steer("execution", "message", "text"), "sent");
    assert.equal(await control.interrupt("execution", "linear_stop_requested"), true);
    assert.equal(
      await control.respondToPermission("execution", "request", { behavior: "deny" }),
      "resolved",
    );
    assert.deepEqual(await control.readWorkspacePullRequest("execution"), {
      url: "https://github.com/acme/repo/pull/1",
      title: "PR",
    });
    assert.deepEqual(await control.daemonPermissions("daemon"), ["hub.execute", "workspace.write"]);
    assert.deepEqual(calls, [
      ["steer", "execution", "message", "text"],
      ["interrupt", "execution", "linear_stop_requested"],
      ["respondToPermission", "execution", "request", { behavior: "deny" }],
      ["readWorkspacePullRequest", "execution"],
      ["daemonPermissions", "daemon"],
    ]);
  });
});
