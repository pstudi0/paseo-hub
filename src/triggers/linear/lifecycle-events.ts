import { z } from "zod";

/**
 * The Linear deliveries that change what the app user may do rather than what it should do:
 * team access grants, de-authorization, and inbox notifications addressed to the app user. None
 * of them starts a run; they are claimed once and applied to the connection.
 */

export const LinearPermissionChangeSchema = z.object({
  type: z.literal("PermissionChange"),
  action: z.literal("teamAccessChanged"),
  organizationId: z.string().min(1),
  oauthClientId: z.string().min(1),
  appUserId: z.string().min(1),
  canAccessAllPublicTeams: z.boolean(),
  addedTeamIds: z.array(z.string()),
  removedTeamIds: z.array(z.string()),
  webhookId: z.string(),
  createdAt: z.string(),
});

export const LinearOAuthAppRevokedSchema = z.object({
  type: z.literal("OAuthApp"),
  action: z.literal("revoked"),
  organizationId: z.string().min(1),
  oauthClientId: z.string().min(1),
  webhookId: z.string(),
  createdAt: z.string(),
});

export const LinearAppUserNotificationSchema = z.object({
  type: z.literal("AppUserNotification"),
  action: z.string().min(1),
  organizationId: z.string().min(1),
  oauthClientId: z.string().min(1),
  appUserId: z.string().min(1),
  notification: z
    .object({
      id: z.string().optional(),
      issueId: z.string().optional(),
      actorId: z.string().nullable().optional(),
      /** The comment that was posted; present on comment notifications. */
      commentId: z.string().optional(),
      /** The thread's root comment when the new comment is a reply; absent on a root comment. */
      parentCommentId: z.string().nullable().optional(),
    })
    .passthrough(),
  webhookId: z.string(),
  createdAt: z.string(),
});

export type LinearPermissionChange = z.infer<typeof LinearPermissionChangeSchema>;
export type LinearOAuthAppRevoked = z.infer<typeof LinearOAuthAppRevokedSchema>;
export type LinearAppUserNotification = z.infer<typeof LinearAppUserNotificationSchema>;

export type LinearLifecycleEvent =
  | ({ kind: "permission_change" } & LinearPermissionChange)
  | ({ kind: "revoked" } & LinearOAuthAppRevoked)
  | ({ kind: "notification" } & LinearAppUserNotification);

/**
 * Recognizes `PermissionChange`, `OAuthApp` (only `revoked`) and `AppUserNotification`
 * deliveries by the `linear-event` header or the payload's own `type`; anything else, including a
 * payload that does not match its declared shape, is not a lifecycle event.
 */
export function parseLinearLifecycleEvent(
  eventName: string | null,
  payload: unknown,
): LinearLifecycleEvent | undefined {
  if (!isRecord(payload)) return undefined;
  const type = eventName ?? payload["type"];
  if (type === "PermissionChange") {
    const parsed = LinearPermissionChangeSchema.safeParse(payload);
    return parsed.success ? { kind: "permission_change", ...parsed.data } : undefined;
  }
  if (type === "OAuthApp") {
    const parsed = LinearOAuthAppRevokedSchema.safeParse(payload);
    return parsed.success ? { kind: "revoked", ...parsed.data } : undefined;
  }
  if (type === "AppUserNotification") {
    const parsed = LinearAppUserNotificationSchema.safeParse(payload);
    return parsed.success ? { kind: "notification", ...parsed.data } : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
