import { z } from "zod";

/**
 * The explicit authority a trigger grants Hub over the Linear issue behind an agent session:
 * workflow-state transitions, delegation, and what the session timeline mirrors. Without this
 * block Hub never moves an issue or claims it; the timeline mirror applies its own defaults.
 */

/** Linear's fixed workflow-state types, in Linear's own vocabulary. */
export const LINEAR_WORKFLOW_STATE_TYPES = [
  "started",
  "unstarted",
  "backlog",
  "triage",
  "completed",
  "canceled",
] as const;

export type LinearWorkflowStateType = (typeof LINEAR_WORKFLOW_STATE_TYPES)[number];

/**
 * Which workflow state an issue moves to: a state type selects the first state of that type by
 * position on the issue's team; anything else is the exact name of one of the team's states.
 */
export type LinearStateSelector =
  | { kind: "type"; type: LinearWorkflowStateType }
  | { kind: "name"; name: string };

export type LinearMirrorThoughts = "none" | "summary" | "all";

export interface AuthoredLinearAuthority {
  on_start?: string | undefined;
  on_pull_request?: string | undefined;
  on_complete?: string | undefined;
  delegate?: boolean | undefined;
  mirror?:
    | {
        actions?: boolean | undefined;
        thoughts?: LinearMirrorThoughts | undefined;
        plan?: boolean | undefined;
        permissions?: boolean | undefined;
      }
    | undefined;
}

export interface CompiledLinearMirror {
  actions: boolean;
  thoughts: LinearMirrorThoughts;
  plan: boolean;
  permissions: boolean;
}

export interface CompiledLinearAuthority {
  onStart?: LinearStateSelector | undefined;
  onPullRequest?: LinearStateSelector | undefined;
  onComplete?: LinearStateSelector | undefined;
  delegate: boolean;
  mirror: CompiledLinearMirror;
}

export const DEFAULT_LINEAR_MIRROR: CompiledLinearMirror = {
  actions: true,
  thoughts: "summary",
  plan: true,
  permissions: true,
};

export const LinearStateSelectorSchema = z.string().min(1);
const LinearMirrorThoughtsSchema = z.enum(["none", "summary", "all"]);

export const AuthoredLinearAuthoritySchema = z
  .object({
    on_start: LinearStateSelectorSchema.optional(),
    on_pull_request: LinearStateSelectorSchema.optional(),
    on_complete: LinearStateSelectorSchema.optional(),
    /** Set the app user as Issue.delegate when the session was created by a human. Default false. */
    delegate: z.boolean().optional(),
    mirror: z
      .object({
        actions: z.boolean().optional(),
        thoughts: LinearMirrorThoughtsSchema.optional(),
        plan: z.boolean().optional(),
        permissions: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const CompiledLinearStateSelectorSchema: z.ZodType<LinearStateSelector> = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("type"), type: z.enum(LINEAR_WORKFLOW_STATE_TYPES) }).strict(),
    z.object({ kind: z.literal("name"), name: z.string().min(1) }).strict(),
  ],
);

export const CompiledLinearAuthoritySchema: z.ZodType<CompiledLinearAuthority> = z
  .object({
    onStart: CompiledLinearStateSelectorSchema.optional(),
    onPullRequest: CompiledLinearStateSelectorSchema.optional(),
    onComplete: CompiledLinearStateSelectorSchema.optional(),
    delegate: z.boolean(),
    mirror: z
      .object({
        actions: z.boolean(),
        thoughts: LinearMirrorThoughtsSchema,
        plan: z.boolean(),
        permissions: z.boolean(),
      })
      .strict(),
  })
  .strict();

export function compileLinearAuthority(
  value: AuthoredLinearAuthority,
  path: string,
): CompiledLinearAuthority {
  const onStart = compileStateSelector(value.on_start, `${path}.on_start`);
  const onPullRequest = compileStateSelector(value.on_pull_request, `${path}.on_pull_request`);
  const onComplete = compileStateSelector(value.on_complete, `${path}.on_complete`);
  return {
    ...(onStart === undefined ? {} : { onStart }),
    ...(onPullRequest === undefined ? {} : { onPullRequest }),
    ...(onComplete === undefined ? {} : { onComplete }),
    delegate: value.delegate ?? false,
    mirror: {
      actions: value.mirror?.actions ?? DEFAULT_LINEAR_MIRROR.actions,
      thoughts: value.mirror?.thoughts ?? DEFAULT_LINEAR_MIRROR.thoughts,
      plan: value.mirror?.plan ?? DEFAULT_LINEAR_MIRROR.plan,
      permissions: value.mirror?.permissions ?? DEFAULT_LINEAR_MIRROR.permissions,
    },
  };
}

export function validateLinearAuthority(value: CompiledLinearAuthority, path: string): void {
  const parsed = CompiledLinearAuthoritySchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${path}${issue === undefined || issue.path.length === 0 ? "" : `.${issue.path.join(".")}`}: ${issue?.message ?? "invalid Linear authority"}`,
    );
  }
  for (const [field, selector] of [
    ["onStart", value.onStart],
    ["onPullRequest", value.onPullRequest],
    ["onComplete", value.onComplete],
  ] as const) {
    if (selector?.kind === "name" && selector.name.trim().length === 0) {
      throw new Error(`${path}.${field} must name a workflow state`);
    }
  }
}

/** The authored form of a compiled block, for round-tripping compiled steps back into YAML. */
export function authorLinearAuthority(value: CompiledLinearAuthority): AuthoredLinearAuthority {
  return {
    ...(value.onStart === undefined ? {} : { on_start: authorStateSelector(value.onStart) }),
    ...(value.onPullRequest === undefined
      ? {}
      : { on_pull_request: authorStateSelector(value.onPullRequest) }),
    ...(value.onComplete === undefined
      ? {}
      : { on_complete: authorStateSelector(value.onComplete) }),
    ...(value.delegate ? { delegate: true } : {}),
    mirror: { ...value.mirror },
  };
}

function compileStateSelector(
  value: string | undefined,
  path: string,
): LinearStateSelector | undefined {
  if (value === undefined) return undefined;
  if (value.trim().length === 0) throw new Error(`${path} must name a workflow state`);
  return isWorkflowStateType(value) ? { kind: "type", type: value } : { kind: "name", name: value };
}

function authorStateSelector(selector: LinearStateSelector): string {
  return selector.kind === "type" ? selector.type : selector.name;
}

function isWorkflowStateType(value: string): value is LinearWorkflowStateType {
  return (LINEAR_WORKFLOW_STATE_TYPES as readonly string[]).includes(value);
}
