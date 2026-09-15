import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { createHubApplication } from "./app.js";
import { createMemoryDatabase } from "./db/memory.js";
import { createUnlimitedEntitlementsService } from "./entitlements/test-utils.js";
import {
  createDeferredExecutionControl,
  ExecutionControlUnboundError,
  type ExecutionControl,
} from "./daemons/execution-control.js";

describe("Hub application", () => {
  it("serves execution completion capabilities without reply executors", async () => {
    const application = createHubApplication({
      database: createMemoryDatabase(),
      entitlements: createUnlimitedEntitlementsService(),
      publicApi: { status: "unavailable" },
    });

    const response = await application.operations.handleExecutionCapabilities(
      new Request("https://hub.test/mcp", { method: "POST" }),
      randomUUID(),
    );

    assert.equal(response.status, 401);
  });

  it("hands provider factories the execution control and binds it to the daemon lifecycle", async () => {
    const executionControl = createDeferredExecutionControl();
    await assert.rejects(
      () => executionControl.daemonPermissions("daemon"),
      ExecutionControlUnboundError,
    );
    let received: ExecutionControl | undefined;
    createHubApplication({
      database: createMemoryDatabase(),
      entitlements: createUnlimitedEntitlementsService(),
      publicApi: { status: "unavailable" },
      executionControl,
      providerFactories: [
        (resources) => {
          received = resources.executionControl;
          return undefined;
        },
      ],
    });

    assert.equal(received, executionControl);
    assert.deepEqual(await executionControl.daemonPermissions("unknown-daemon"), []);
  });

  it("creates and binds its own execution control when none is handed in", async () => {
    let received: ExecutionControl | undefined;
    createHubApplication({
      database: createMemoryDatabase(),
      entitlements: createUnlimitedEntitlementsService(),
      publicApi: { status: "unavailable" },
      providerFactories: [
        (resources) => {
          received = resources.executionControl;
          return undefined;
        },
      ],
    });

    assert.notEqual(received, undefined);
    assert.deepEqual(await received!.daemonPermissions("unknown-daemon"), []);
  });
});
