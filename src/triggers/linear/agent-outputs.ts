import { z } from "zod";
import type { Database } from "../../db/types.js";
import {
  outputContextProvider,
  type OutputExecutor,
  type OutputToolDefinition,
} from "../../execution-capabilities/outputs.js";
import type { LinearPlanStep } from "../../providers/linear/client.js";
import { isGitHubPullRequestUrl, type LinearSessionCoordinator } from "./session-coordinator.js";

/** The output capabilities an agent session exposes as `hub` MCP tools, in registration order. */
export const LINEAR_OUTPUT_TOOLS: Readonly<
  Record<
    "linear.reply" | "linear.response" | "linear.ask" | "linear.plan" | "linear.link",
    OutputToolDefinition
  >
> = {
  "linear.reply": {
    name: "reply",
    description: "Sends a reply to the conversation that triggered this execution.",
    inputSchema: {
      type: "object",
      properties: { content: { type: "string", minLength: 1 } },
      required: ["content"],
      additionalProperties: false,
    },
  },
  "linear.response": {
    name: "linear_response",
    description:
      "Posts the final result of this session to Linear and marks the session complete. Call it once, at the end.",
    inputSchema: {
      type: "object",
      properties: { content: { type: "string", minLength: 1 } },
      required: ["content"],
      additionalProperties: false,
    },
  },
  "linear.ask": {
    name: "linear_ask",
    description:
      "Asks the person who delegated this issue a question in Linear; optional options render as buttons. End your turn after asking.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", minLength: 1 },
        options: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              label: { type: "string", minLength: 1 },
              value: { type: "string", minLength: 1 },
            },
            required: ["label", "value"],
            additionalProperties: false,
          },
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  "linear.plan": {
    name: "linear_plan",
    description: "Replaces the session plan shown in Linear with the given steps.",
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              content: { type: "string", minLength: 1 },
              status: {
                type: "string",
                enum: ["pending", "inProgress", "completed", "canceled"],
              },
            },
            required: ["content", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["steps"],
      additionalProperties: false,
    },
  },
  "linear.link": {
    name: "linear_link",
    description: "Adds an external link (for example a pull request) to the Linear session.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", minLength: 1 },
        url: { type: "string", pattern: "^https://" },
      },
      required: ["label", "url"],
      additionalProperties: false,
    },
  },
};

export type LinearOutputType = keyof typeof LINEAR_OUTPUT_TOOLS;

export const LINEAR_OUTPUT_TYPES: readonly LinearOutputType[] = [
  "linear.reply",
  "linear.response",
  "linear.ask",
  "linear.plan",
  "linear.link",
];

export function linearOutputTool(type: string): OutputToolDefinition | undefined {
  const match = LINEAR_OUTPUT_TYPES.find((candidate) => candidate === type);
  return match === undefined ? undefined : LINEAR_OUTPUT_TOOLS[match];
}

export const LINEAR_SESSION_OUTPUT_TYPES = [
  "linear.response",
  "linear.ask",
  "linear.plan",
  "linear.link",
] as const;

/** Session outputs need a session to write to; issue and comment contexts never expose them. */
export function linearAgentSessionAvailable(outputContext: unknown): boolean {
  return (
    typeof outputContext === "object" &&
    outputContext !== null &&
    outputContextProvider("linear")(outputContext) &&
    typeof Reflect.get(outputContext, "sessionId") === "string"
  );
}

export const LinearSessionOutputContextSchema = z.object({
  provider: z.literal("linear"),
  linearOrganizationId: z.string().min(1),
  issueId: z.string().min(1),
  teamId: z.string().min(1),
  sessionId: z.string().min(1),
});

const ResponseArgsSchema = z.object({ content: z.string().min(1) });
const AskArgsSchema = z.object({
  content: z.string().min(1),
  options: z
    .array(z.object({ label: z.string().min(1), value: z.string().min(1) }))
    .min(1)
    .max(10)
    .optional(),
});
const PlanArgsSchema = z.object({
  steps: z
    .array(
      z.object({
        content: z.string().min(1),
        status: z.enum(["pending", "inProgress", "completed", "canceled"]),
      }),
    )
    .max(100),
});
const LinkArgsSchema = z.object({
  label: z.string().min(1),
  url: z.string().regex(/^https:\/\//u),
});

export interface LinearAgentOutputExecutors {
  response: OutputExecutor;
  ask: OutputExecutor;
  plan: OutputExecutor;
  link: OutputExecutor;
}

/**
 * The four session outputs. `response` and `ask` are terminal for the turn: the queue records
 * them so the mirror's fallback response and later chatter stay silent. A failed terminal emission
 * throws so the tool call is released and the agent can retry.
 */
export function createLinearAgentOutputExecutors(options: {
  coordinator: Pick<LinearSessionCoordinator, "emit" | "updateSession" | "publishPullRequest">;
  database: Pick<Database, "findLinearAgentSession">;
}): LinearAgentOutputExecutors {
  return {
    async response(input) {
      const args = ResponseArgsSchema.parse(input.args);
      const context = LinearSessionOutputContextSchema.parse(input.outputContext);
      const result = await options.coordinator.emit(target(context), {
        kind: "activity",
        ...(input.attemptId === undefined ? {} : { id: input.attemptId }),
        content: { type: "response", body: args.content },
        ephemeral: false,
      });
      assertSent(result, "linear.response");
    },
    async ask(input) {
      const args = AskArgsSchema.parse(input.args);
      const context = LinearSessionOutputContextSchema.parse(input.outputContext);
      const result = await options.coordinator.emit(target(context), {
        kind: "activity",
        ...(input.attemptId === undefined ? {} : { id: input.attemptId }),
        content: { type: "elicitation", body: args.content },
        ephemeral: false,
        ...(args.options === undefined
          ? {}
          : { signal: "select", signalMetadata: { options: args.options } }),
      });
      assertSent(result, "linear.ask");
    },
    async plan(input) {
      const args = PlanArgsSchema.parse(input.args);
      const context = LinearSessionOutputContextSchema.parse(input.outputContext);
      const steps: LinearPlanStep[] = args.steps.map((step) => ({
        content: step.content,
        status: step.status,
      }));
      const result = await options.coordinator.updateSession(target(context), {
        plan: steps,
        coalesceKey: "plan",
      });
      if (result === "failed" || result === "dropped") {
        throw new Error("The Linear session plan could not be updated; try again.");
      }
    },
    async link(input) {
      const args = LinkArgsSchema.parse(input.args);
      const context = LinearSessionOutputContextSchema.parse(input.outputContext);
      if (isGitHubPullRequestUrl(args.url)) {
        await options.coordinator.publishPullRequest({
          target: target(context),
          issueId: context.issueId,
          url: args.url,
          title: args.label,
        });
        return;
      }
      const result = await options.coordinator.updateSession(target(context), {
        addedExternalUrls: [{ label: args.label, url: args.url }],
      });
      if (result === "failed" || result === "dropped") {
        throw new Error("The link could not be added to the Linear session; try again.");
      }
    },
  };
}

function target(context: z.infer<typeof LinearSessionOutputContextSchema>) {
  return { sessionId: context.sessionId, linearOrganizationId: context.linearOrganizationId };
}

function assertSent(result: string, type: string): void {
  if (result === "sent") return;
  throw new Error(`${type} could not be delivered to Linear (${result}); try again.`);
}
