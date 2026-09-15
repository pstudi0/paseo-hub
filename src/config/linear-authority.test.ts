import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  AuthoredLinearAuthoritySchema,
  CompiledLinearAuthoritySchema,
  authorLinearAuthority,
  compileLinearAuthority,
  validateLinearAuthority,
} from "./linear-authority.js";

describe("Linear authority block", () => {
  it("compiles state types and exact state names into distinct selectors with mirror defaults", () => {
    const compiled = compileLinearAuthority(
      { on_start: "started", on_pull_request: "In Review", mirror: { thoughts: "all" } },
      "trigger t step run linear",
    );
    assert.deepEqual(compiled, {
      onStart: { kind: "type", type: "started" },
      onPullRequest: { kind: "name", name: "In Review" },
      delegate: false,
      mirror: { actions: true, thoughts: "all", plan: true, permissions: true },
    });
    assert.doesNotThrow(() => validateLinearAuthority(compiled, "trigger t step run linear"));
    assert.deepEqual(CompiledLinearAuthoritySchema.parse(compiled), compiled);
  });

  it("keeps every consequence opt-in when the block is empty", () => {
    assert.deepEqual(compileLinearAuthority({}, "path"), {
      delegate: false,
      mirror: { actions: true, thoughts: "summary", plan: true, permissions: true },
    });
  });

  it("refuses blank state selectors and unknown keys", () => {
    assert.throws(
      () => compileLinearAuthority({ on_complete: "   " }, "trigger t step run linear"),
      /trigger t step run linear\.on_complete must name a workflow state/u,
    );
    assert.equal(AuthoredLinearAuthoritySchema.safeParse({ on_done: "Done" }).success, false);
    assert.equal(
      AuthoredLinearAuthoritySchema.safeParse({ mirror: { thoughts: "verbose" } }).success,
      false,
    );
    assert.throws(
      () =>
        validateLinearAuthority(
          {
            onStart: { kind: "name", name: "   " },
            delegate: false,
            mirror: { actions: true, thoughts: "summary", plan: true, permissions: true },
          },
          "trigger t step run linear",
        ),
      /trigger t step run linear\.onStart must name a workflow state/u,
    );
    assert.equal(
      CompiledLinearAuthoritySchema.safeParse({
        onStart: { kind: "type", type: "done" },
        delegate: false,
        mirror: { actions: true, thoughts: "summary", plan: true, permissions: true },
      }).success,
      false,
    );
  });

  it("round-trips a compiled block back to its authored form", () => {
    const authored = {
      on_start: "started",
      on_pull_request: "In Review",
      on_complete: "completed",
      delegate: true,
      mirror: { actions: false, thoughts: "none" as const, plan: true, permissions: false },
    };
    const compiled = compileLinearAuthority(authored, "path");
    assert.deepEqual(authorLinearAuthority(compiled), authored);
    assert.deepEqual(compileLinearAuthority(authorLinearAuthority(compiled), "path"), compiled);
  });
});
