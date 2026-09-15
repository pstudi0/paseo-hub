import { z } from "zod";

export const ContinuationSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("conversation") }).strict(),
  z
    .object({
      mode: z.literal("key"),
      key: z
        .string()
        .min(1)
        .max(512)
        .refine((key) => key.trim().length > 0, "Continuation key must not be blank"),
    })
    .strict(),
  z.object({ mode: z.literal("new") }).strict(),
  /**
   * Two-level continuation for Linear agent sessions: the conversation key selects the agent
   * (one per Linear session) and the workspace key selects the workspace (one per issue).
   */
  z.object({ mode: z.literal("linear") }).strict(),
]);
export type Continuation = z.infer<typeof ContinuationSchema>;
export interface Conversation {
  key: string;
  label: string;
  url?: string;
  /** The workspace shared by every conversation of the same subject; only Linear sessions set it. */
  workspaceKey?: string;
}

export function continuationKey(
  policy: Continuation,
  conversation: Conversation | null,
  render: (template: string) => unknown,
): string | null {
  if (policy.mode === "new") return null;
  if (policy.mode === "conversation" || policy.mode === "linear") {
    return conversation?.key ?? null;
  }
  const key = render(policy.key);
  if (typeof key !== "string" || key.trim().length === 0 || key.length > 512) {
    throw new Error(
      "Continuation key must resolve to a non-empty string of at most 512 characters",
    );
  }
  return `custom:${key}`;
}

/** The workspace a new agent should be created in; only the `linear` mode has a second level. */
export function continuationWorkspaceKey(
  policy: Continuation,
  conversation: Conversation | null,
): string | null {
  if (policy.mode !== "linear") return null;
  return conversation?.workspaceKey ?? null;
}
