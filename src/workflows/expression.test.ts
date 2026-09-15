import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  parseExpression,
  renderExecutionTemplate,
  renderExpressionTemplate,
  validateExecutionTemplate,
} from "./expression.js";

describe("workflow expression context", () => {
  it("keeps the triggering prompt and ambient context as distinct merge values", () => {
    const context = {
      prompt: "the triggering body",
      context: { slack: { thread: { messages: [{ content: "earlier" }] } } },
      inputs: {},
      steps: {},
      values: {},
    };

    assert.equal(renderExpressionTemplate("${{ paseo.prompt }}", context), "the triggering body");
    assert.equal(
      renderExpressionTemplate("${{ paseo.context }}", context),
      JSON.stringify(context.context),
    );
    assert.deepEqual(parseExpression("${{ paseo.context }}"), {
      kind: "path",
      value: { namespace: "paseo", path: "context" },
    });
  });

  it("renders the stable execution ID without provider context", () => {
    assert.equal(
      renderExecutionTemplate(
        "trigger-${{ paseo.execution.id }}",
        "64ae56ff-281c-4c5f-bf5c-d572f125c702",
      ),
      "trigger-64ae56ff-281c-4c5f-bf5c-d572f125c702",
    );
  });

  it("reads the Linear issue identifier only in execution templates that opt in", () => {
    assert.deepEqual(parseExpression("${{ linear.issue.identifier }}"), {
      kind: "path",
      value: { namespace: "linear", path: ["issue", "identifier"] },
    });
    assert.throws(() => parseExpression("${{ linear.issue.branchName }}"), /unexpected token/u);
    assert.throws(() => parseExpression("${{ linear.issue.title }}"), /unsupported path/u);
    assert.throws(() => parseExpression("${{ linear.issue }}"), /unsupported path/u);

    const template = "linear/${{ linear.issue.identifier }}-${{ paseo.execution.id }}";
    assert.equal(
      renderExecutionTemplate(template, "exec-1", { issue: { identifier: "SEN-42" } }),
      "linear/SEN-42-exec-1",
    );
    assert.throws(
      () => renderExecutionTemplate(template, "exec-1"),
      /Linear issue identifier is unavailable/u,
    );
    assert.throws(
      () => validateExecutionTemplate(template),
      /linear\.issue\.identifier only for Linear agent session triggers/u,
    );
    assert.doesNotThrow(() => validateExecutionTemplate(template, { allowLinearIssue: true }));
    assert.throws(
      () => validateExecutionTemplate("${{ paseo.prompt }}", { allowLinearIssue: true }),
      /only paseo\.execution\.id/u,
    );
    assert.throws(
      () =>
        renderExpressionTemplate("${{ linear.issue.identifier }}", {
          prompt: "",
          context: null,
          inputs: {},
          steps: {},
          values: {},
        }),
      /Linear issue identifier is unavailable/u,
    );
  });
});
