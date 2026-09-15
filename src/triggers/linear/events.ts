import { z } from "zod";
import { logger } from "../../logger.js";
import type { LinearIssueDetails } from "../../providers/linear/client.js";
import type { LinearSessionSource } from "../configuration/events.js";

const LinearIdSchema = z.string().min(1);
const LinearActorSchema = z.object({ id: LinearIdSchema, name: z.string().optional() });
const LinearIssueSchema = z.object({
  id: LinearIdSchema,
  identifier: z.string().min(1).optional(),
  title: z.string(),
  description: z.string().nullable(),
  url: z.string().url().optional(),
  projectId: LinearIdSchema.nullable(),
  stateId: LinearIdSchema.nullable(),
  assigneeId: LinearIdSchema.nullable(),
  labelIds: z.array(LinearIdSchema),
});
const LinearIssuePreviousSchema = z.object({
  projectId: LinearIdSchema.nullable().optional(),
  stateId: LinearIdSchema.nullable().optional(),
  assigneeId: LinearIdSchema.nullable().optional(),
  labelIds: z.array(LinearIdSchema).optional(),
});

export const NormalizedLinearIssueEventSchema = z.object({
  type: z.literal("issue"),
  action: z.enum(["create", "update", "remove"]),
  id: LinearIdSchema,
  organizationId: LinearIdSchema,
  actor: LinearActorSchema.nullable(),
  issue: LinearIssueSchema,
  updatedFrom: LinearIssuePreviousSchema,
  occurredAt: z.string().datetime().optional(),
});

export const NormalizedLinearCommentEventSchema = z.object({
  type: z.literal("comment"),
  action: z.enum(["create", "update", "remove"]),
  id: LinearIdSchema,
  organizationId: LinearIdSchema,
  actor: LinearActorSchema.nullable(),
  comment: z.object({ id: LinearIdSchema, body: z.string(), issueId: LinearIdSchema }),
  issue: LinearIssueSchema.nullable(),
  occurredAt: z.string().datetime().optional(),
});

const LinearUserSchema = z.object({
  id: LinearIdSchema,
  name: z.string().optional(),
  email: z.string().optional(),
  url: z.string().optional(),
});
const LinearTeamSchema = z.object({ id: LinearIdSchema, key: z.string().min(1), name: z.string() });
/** `IssueWithDescriptionChildWebhookPayload`: no branch name, state, or labels are delivered. */
const LinearSessionIssueSchema = z.object({
  id: LinearIdSchema,
  identifier: z.string().min(1),
  title: z.string(),
  description: z.string().nullable(),
  url: z.string().url(),
  teamId: LinearIdSchema,
  team: LinearTeamSchema,
});
const LinearGuidanceSchema = z.object({
  body: z.string(),
  origin: z.discriminatedUnion("type", [
    z.object({ type: z.literal("Organization") }),
    z.object({ type: z.literal("Team"), team: LinearTeamSchema.optional() }),
  ]),
});
const LinearThreadCommentSchema = z.object({
  id: LinearIdSchema,
  body: z.string(),
  userId: LinearIdSchema.nullable(),
});

/**
 * An `AgentSessionEvent` delivery. Every relation Linear leaves unset (creator, comment, issue,
 * signal, ...) is normalized to `null` so the persisted payload has one shape per field.
 */
export const NormalizedLinearAgentSessionEventSchema = z.object({
  type: z.literal("agent_session"),
  action: z.enum(["created", "prompted"]),
  /** `agentSession.id` for `created`; `agentActivity.id` for `prompted`. */
  id: LinearIdSchema,
  organizationId: LinearIdSchema,
  appUserId: LinearIdSchema,
  oauthClientId: LinearIdSchema,
  session: z.object({
    id: LinearIdSchema,
    status: z.string(),
    url: z.string().url().nullable(),
    createdAt: z.string().datetime(),
    commentId: LinearIdSchema.nullable(),
    sourceCommentId: LinearIdSchema.nullable(),
    creator: LinearUserSchema.nullable(),
    issue: LinearSessionIssueSchema.nullable(),
    comment: LinearThreadCommentSchema.nullable(),
  }),
  promptContext: z.string().nullable(),
  guidance: z.array(LinearGuidanceSchema),
  previousComments: z.array(LinearThreadCommentSchema),
  /** The prompt activity; always present for `prompted`, never for `created`. */
  activity: z
    .object({
      id: LinearIdSchema,
      body: z.string(),
      createdAt: z.string().datetime(),
      signal: z.string().nullable(),
      signalMetadata: z.unknown().nullable(),
      sourceCommentId: LinearIdSchema.nullable(),
      user: LinearUserSchema,
    })
    .nullable(),
  /** The envelope's `createdAt`: the event time, never the signed delivery timestamp. */
  occurredAt: z.string().datetime(),
  /** The `linear-delivery` header of the accepted delivery; set by the webhook, never inferred. */
  transportDeliveryId: z.string().optional(),
});

export const NormalizedLinearEventSchema = z.discriminatedUnion("type", [
  NormalizedLinearIssueEventSchema,
  NormalizedLinearCommentEventSchema,
  NormalizedLinearAgentSessionEventSchema,
]);

export type NormalizedLinearIssue = z.infer<typeof LinearIssueSchema>;
export type NormalizedLinearIssueEvent = z.infer<typeof NormalizedLinearIssueEventSchema>;
export type NormalizedLinearCommentEvent = z.infer<typeof NormalizedLinearCommentEventSchema>;
export type NormalizedLinearAgentSessionEvent = z.infer<
  typeof NormalizedLinearAgentSessionEventSchema
>;
export type NormalizedLinearEvent = z.infer<typeof NormalizedLinearEventSchema>;
export type NormalizedLinearSessionIssue = NonNullable<
  NormalizedLinearAgentSessionEvent["session"]["issue"]
>;
export type NormalizedLinearThreadComment = z.infer<typeof LinearThreadCommentSchema>;

/**
 * Linear's webhook data follows its entity model but not every event embeds related objects. This
 * adapter accepts both the compact webhook shape and relation-expanded test/development payloads.
 */
export function normalizeLinearEvent(
  payload: unknown,
  eventName?: string | null,
  hydratedIssue?: LinearIssueDetails,
): NormalizedLinearEvent | undefined {
  if (!isRecord(payload)) return undefined;
  const family = readLinearEventFamily(eventName, payload["type"]);
  if (family === "agent_session") return normalizeAgentSessionEvent(payload);
  const envelope = readEnvelope(payload, family);
  if (envelope === undefined) return undefined;
  return envelope.kind === "issue"
    ? normalizeIssueEvent(envelope, hydratedIssue)
    : normalizeCommentEvent(envelope, hydratedIssue);
}

export function eventIssueId(event: NormalizedLinearEvent): string {
  if (event.type === "issue") return event.issue.id;
  if (event.type === "comment") return event.comment.issueId;
  if (event.session.issue === null) throw new Error("Linear session has no issue");
  return event.session.issue.id;
}

/**
 * The resource a delivery is routed by: the issue's project for issue and comment events, the
 * issue's team for agent sessions. Undefined when the payload does not carry it.
 */
export function eventRouteResourceId(event: NormalizedLinearEvent): string | undefined {
  if (event.type === "agent_session") return event.session.issue?.teamId;
  return event.issue?.projectId ?? undefined;
}

/**
 * How a session started. A mention leaves evidence Linear documents: earlier thread comments, a
 * source comment from another thread, or a root comment written by a human. Without that
 * evidence, a session without a responsible human is an automation; otherwise it was delegated.
 * The bare presence of `session.comment` is not evidence: Linear attaches an artificial root
 * comment to sessions started without a mention.
 */
export function linearSessionSource(event: NormalizedLinearAgentSessionEvent): LinearSessionSource {
  const { session } = event;
  if (
    event.previousComments.length > 0 ||
    session.sourceCommentId !== null ||
    humanRootComment(event) !== null
  ) {
    return "mention";
  }
  return session.creator === null ? "automation" : "delegation";
}

/**
 * The root comment of the session's thread when a human wrote it: the one text of a new session
 * that is the human's own words. Linear's artificial root comment (absent author, the app user,
 * or a blank body) is never treated as such, so it is neither mention evidence nor parser input.
 */
export function humanRootComment(
  event: NormalizedLinearAgentSessionEvent,
): NormalizedLinearThreadComment | null {
  const comment = event.session.comment;
  if (comment === null || comment.userId === null || comment.userId === event.appUserId) {
    return null;
  }
  return comment.body.trim() === "" ? null : comment;
}

interface LinearEnvelope {
  kind: "issue" | "comment";
  action: "create" | "update" | "remove";
  organizationId: string;
  payload: Record<string, unknown>;
  data: Record<string, unknown>;
  occurredAt?: string;
}

function readEnvelope(
  payload: Record<string, unknown>,
  kind: "issue" | "comment" | undefined,
): LinearEnvelope | undefined {
  const action = readAction(payload["action"]);
  const organizationId = readString(payload["organizationId"]);
  const data = asRecord(payload["data"]);
  if (
    action === undefined ||
    organizationId === undefined ||
    data === undefined ||
    kind === undefined
  ) {
    return undefined;
  }
  // A signed delivery timestamp proves freshness, but it is not a causal event timestamp: a
  // comment can be created before the delivery is emitted. Prefer the comment's own timestamp
  // so deferred history can exclude the trigger and all later comments. If neither entity nor
  // event time is supplied, context materialization safely leaves history unavailable.
  const occurredAt = firstDefined(
    kind === "comment" ? readDate(data["createdAt"]) : undefined,
    readDate(payload["createdAt"]),
  );
  return {
    kind,
    action,
    organizationId,
    payload,
    data,
    ...(occurredAt === undefined ? {} : { occurredAt }),
  };
}

function normalizeIssueEvent(
  envelope: LinearEnvelope,
  hydratedIssue: LinearIssueDetails | undefined,
): NormalizedLinearEvent | undefined {
  const issue = normalizeIssue(envelope.data, hydratedIssue);
  if (issue === undefined) return undefined;
  return NormalizedLinearIssueEventSchema.parse({
    type: "issue",
    action: envelope.action,
    id: firstDefined(readString(envelope.data["id"]), issue.id),
    organizationId: envelope.organizationId,
    actor: normalizeActor(envelope.payload["actor"]),
    issue,
    updatedFrom: normalizePreviousIssue(envelope.payload["updatedFrom"]),
    ...(envelope.occurredAt === undefined ? {} : { occurredAt: envelope.occurredAt }),
  });
}

function normalizeCommentEvent(
  envelope: LinearEnvelope,
  hydratedIssue: LinearIssueDetails | undefined,
): NormalizedLinearEvent | undefined {
  const commentId = readString(envelope.data["id"]);
  const issueId = firstDefined(
    readString(envelope.data["issueId"]),
    readString(asRecord(envelope.data["issue"])?.["id"]),
  );
  if (commentId === undefined || issueId === undefined) return undefined;
  return NormalizedLinearCommentEventSchema.parse({
    type: "comment",
    action: envelope.action,
    id: commentId,
    organizationId: envelope.organizationId,
    actor:
      normalizeActor(envelope.payload["actor"]) ??
      normalizeActor(envelope.data["user"]) ??
      actorFromUserId(envelope.data) ??
      null,
    comment: { id: commentId, body: readString(envelope.data["body"]) ?? "", issueId },
    issue: normalizeIssue(asRecord(envelope.data["issue"]) ?? {}, hydratedIssue) ?? null,
    ...(envelope.occurredAt === undefined ? {} : { occurredAt: envelope.occurredAt }),
  });
}

/**
 * Built by hand rather than parsed directly: Linear omits unset relations instead of sending
 * `null`, and the normalized payload commits to `null` for every one of them. A payload missing a
 * field the SDL declares non-null is not a session event Hub understands and normalizes to
 * `undefined`, like an issue without a title. The final schema check catches what the field
 * readers cannot (a malformed URL, an unknown guidance origin) and answers the same way: a
 * delivery that will never parse is ignored, not retried.
 */
function normalizeAgentSessionEvent(
  payload: Record<string, unknown>,
): NormalizedLinearAgentSessionEvent | undefined {
  const action = readSessionAction(payload["action"]);
  const organizationId = readString(payload["organizationId"]);
  const appUserId = readString(payload["appUserId"]);
  const oauthClientId = readString(payload["oauthClientId"]);
  const occurredAt = readDate(payload["createdAt"]);
  const session = normalizeAgentSession(asRecord(payload["agentSession"]));
  const guidance = mapAll(readArray(payload["guidance"]), normalizeGuidance);
  const previousComments = mapAll(readArray(payload["previousComments"]), (comment) =>
    normalizeThreadComment(comment, "required"),
  );
  if (
    action === undefined ||
    organizationId === undefined ||
    appUserId === undefined ||
    oauthClientId === undefined ||
    occurredAt === undefined ||
    session === undefined ||
    guidance === undefined ||
    previousComments === undefined
  ) {
    return undefined;
  }
  const activity =
    action === "prompted" ? normalizeAgentActivity(asRecord(payload["agentActivity"])) : null;
  if (activity === undefined) return undefined;
  const normalized = NormalizedLinearAgentSessionEventSchema.safeParse({
    type: "agent_session",
    action,
    id: activity === null ? session.id : activity.id,
    organizationId,
    appUserId,
    oauthClientId,
    session,
    promptContext: nullableValue(payload, "promptContext", null),
    guidance,
    previousComments,
    activity,
    occurredAt,
  });
  if (normalized.success) return normalized.data;
  logger.info(
    {
      agentSessionId: session.id,
      issues: normalized.error.issues.map((issue) => issue.path.join(".")),
    },
    "ignoring malformed Linear agent session event",
  );
  return undefined;
}

function normalizeAgentSession(
  data: Record<string, unknown> | undefined,
): NormalizedLinearAgentSessionEvent["session"] | undefined {
  if (data === undefined) return undefined;
  const id = readString(data["id"]);
  const status = readString(data["status"]);
  const createdAt = readDate(data["createdAt"]);
  const issue = normalizeSessionIssue(asRecord(data["issue"]));
  const comment = normalizeThreadComment(data["comment"], "optional");
  if (
    id === undefined ||
    status === undefined ||
    createdAt === undefined ||
    issue === undefined ||
    comment === undefined
  ) {
    return undefined;
  }
  return {
    id,
    status,
    url: nullableValue(data, "url", null),
    createdAt,
    commentId: nullableValue(data, "commentId", null),
    sourceCommentId: nullableValue(data, "sourceCommentId", null),
    creator: normalizeUser(data["creator"]) ?? null,
    issue,
    comment,
  };
}

/** `null` when the session has no issue; `undefined` when the delivered issue is malformed. */
function normalizeSessionIssue(
  data: Record<string, unknown> | undefined,
): NormalizedLinearSessionIssue | null | undefined {
  if (data === undefined) return null;
  const id = readString(data["id"]);
  const identifier = readString(data["identifier"]);
  const title = readNullableString(data["title"]);
  const url = readString(data["url"]);
  const team = normalizeTeam(asRecord(data["team"]));
  const teamId = readString(data["teamId"]) ?? team?.id;
  if (
    id === undefined ||
    identifier === undefined ||
    typeof title !== "string" ||
    url === undefined ||
    team === undefined ||
    teamId === undefined
  ) {
    return undefined;
  }
  return {
    id,
    identifier,
    title,
    description: nullableValue(data, "description", null),
    url,
    teamId,
    team,
  };
}

function normalizeAgentActivity(
  data: Record<string, unknown> | undefined,
): NormalizedLinearAgentSessionEvent["activity"] | undefined {
  if (data === undefined) return undefined;
  const id = readString(data["id"]);
  const createdAt = readDate(data["createdAt"]);
  const content = asRecord(data["content"]);
  const user = normalizeUser(data["user"]);
  // Only a prompt carries a human message; every other content type is the agent's own output.
  if (
    id === undefined ||
    createdAt === undefined ||
    content?.["type"] !== "prompt" ||
    typeof content["body"] !== "string" ||
    user === undefined
  ) {
    return undefined;
  }
  return {
    id,
    body: content["body"],
    createdAt,
    signal: nullableValue(data, "signal", null),
    signalMetadata: data["signalMetadata"] ?? null,
    sourceCommentId: nullableValue(data, "sourceCommentId", null),
    user,
  };
}

function normalizeGuidance(value: unknown): z.infer<typeof LinearGuidanceSchema> | undefined {
  const guidance = asRecord(value);
  const origin = asRecord(guidance?.["origin"]);
  const body = readNullableString(guidance?.["body"]);
  if (guidance === undefined || origin === undefined || typeof body !== "string") return undefined;
  if (origin["type"] === "Organization") return { body, origin: { type: "Organization" } };
  if (origin["type"] !== "Team") return undefined;
  const team = normalizeTeam(asRecord(origin["team"]));
  return { body, origin: { type: "Team", ...(team === undefined ? {} : { team }) } };
}

/**
 * `null` when an optional comment is absent; `undefined` when a delivered comment is malformed
 * or a required one is absent.
 */
function normalizeThreadComment(
  value: unknown,
  presence: "required" | "optional",
): z.infer<typeof LinearThreadCommentSchema> | null | undefined {
  const comment = asRecord(value);
  if (comment === undefined) return presence === "optional" ? null : undefined;
  const id = readString(comment["id"]);
  const body = readNullableString(comment["body"]);
  if (id === undefined || typeof body !== "string") return undefined;
  return { id, body, userId: nullableValue(comment, "userId", null) };
}

function normalizeUser(value: unknown): z.infer<typeof LinearUserSchema> | undefined {
  const user = asRecord(value);
  const id = readString(user?.["id"]);
  if (user === undefined || id === undefined) return undefined;
  return {
    id,
    ...optionalProperty("name", readString(user["name"]) ?? readString(user["displayName"])),
    ...optionalProperty("email", readString(user["email"])),
    ...optionalProperty("url", readString(user["url"])),
  };
}

function normalizeTeam(
  value: Record<string, unknown> | undefined,
): z.infer<typeof LinearTeamSchema> | undefined {
  const id = readString(value?.["id"]);
  const key = readString(value?.["key"]);
  const name = readNullableString(value?.["name"]);
  if (id === undefined || key === undefined || typeof name !== "string") return undefined;
  return { id, key, name };
}

/** Every element normalized, or `undefined` as soon as one is malformed. */
function mapAll<T>(
  values: unknown[],
  normalize: (value: unknown) => T | undefined,
): T[] | undefined {
  const normalized: T[] = [];
  for (const value of values) {
    const item = normalize(value);
    if (item === undefined) return undefined;
    normalized.push(item);
  }
  return normalized;
}

function normalizeIssue(
  data: Record<string, unknown>,
  hydrated: LinearIssueDetails | undefined,
): NormalizedLinearIssue | undefined {
  const id = firstDefined(readString(data["id"]), hydrated?.id);
  if (id === undefined) return undefined;
  const title = firstDefined(readString(data["title"]), hydrated?.title);
  if (title === undefined) return undefined;
  const identifier = firstDefined(readString(data["identifier"]), hydrated?.identifier);
  const url = firstDefined(readString(data["url"]), hydrated?.url);
  return {
    id,
    ...optionalProperty("identifier", identifier),
    title,
    description: nullableValue(data, "description", hydrated?.description ?? null),
    ...optionalProperty("url", url),
    projectId: relatedId(data, "projectId", "project", hydrated?.projectId ?? null),
    stateId: relatedId(data, "stateId", "state", hydrated?.stateId ?? null),
    assigneeId: relatedId(data, "assigneeId", "assignee", hydrated?.assigneeId ?? null),
    labelIds: firstDefined(readLabelIds(data), hydrated?.labelIds) ?? [],
  };
}

function actorFromUserId(data: Record<string, unknown>): { id: string } | undefined {
  const id = readString(data["userId"]);
  return id === undefined ? undefined : { id };
}

function nullableValue(
  data: Record<string, unknown>,
  key: string,
  fallback: string | null,
): string | null {
  const value = readNullableString(data[key]);
  return value === undefined ? fallback : value;
}

function relatedId(
  data: Record<string, unknown>,
  directKey: string,
  relationKey: string,
  fallback: string | null,
): string | null {
  const direct = readNullableId(data, directKey);
  if (direct !== undefined) return direct;
  if (hasOwn(data, relationKey) && data[relationKey] === null) return null;
  const nested = readNullableId(asRecord(data[relationKey]), "id");
  return nested === undefined ? fallback : nested;
}

function optionalProperty(key: string, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { [key]: value };
}

function firstDefined<T>(...values: readonly (T | undefined)[]): T | undefined {
  return values.find((value) => value !== undefined);
}

function normalizePreviousIssue(value: unknown): z.infer<typeof LinearIssuePreviousSchema> {
  const previous = asRecord(value);
  if (previous === undefined) return {};
  return {
    ...(hasOwn(previous, "projectId") || hasOwn(previous, "project")
      ? { projectId: readPreviousRelatedId(previous, "projectId", "project") }
      : {}),
    ...(hasOwn(previous, "stateId") || hasOwn(previous, "state")
      ? { stateId: readPreviousRelatedId(previous, "stateId", "state") }
      : {}),
    ...(hasOwn(previous, "assigneeId") || hasOwn(previous, "assignee")
      ? { assigneeId: readPreviousRelatedId(previous, "assigneeId", "assignee") }
      : {}),
    ...(hasOwn(previous, "labelIds") || hasOwn(previous, "labels")
      ? { labelIds: readLabelIds(previous) ?? [] }
      : {}),
  };
}

function readPreviousRelatedId(
  previous: Record<string, unknown>,
  directKey: string,
  relationKey: string,
): string | null | undefined {
  return firstDefined(
    readNullableId(previous, directKey),
    previous[relationKey] === null ? null : readNullableId(asRecord(previous[relationKey]), "id"),
  );
}

function normalizeActor(value: unknown): { id: string; name?: string } | null {
  const actor = asRecord(value);
  if (actor === undefined) return null;
  const id = readString(actor["id"]);
  if (id === undefined) return null;
  const name = readString(actor["name"]) ?? readString(actor["displayName"]);
  return name === undefined ? { id } : { id, name };
}

/**
 * Agent sessions are recognized by exact type; the entity webhooks keep their historical
 * substring rules so relation-expanded development payloads still normalize.
 */
export function readLinearEventFamily(
  eventName: string | null | undefined,
  type: unknown,
): "issue" | "comment" | "agent_session" | undefined {
  const value = eventName ?? (typeof type === "string" ? type : "");
  if (value === "AgentSessionEvent") return "agent_session";
  const lowered = value.toLowerCase();
  if (lowered.includes("issue")) return "issue";
  if (lowered.includes("comment")) return "comment";
  return undefined;
}

function readAction(value: unknown): "create" | "update" | "remove" | undefined {
  return value === "create" || value === "update" || value === "remove" ? value : undefined;
}

function readSessionAction(value: unknown): "created" | "prompted" | undefined {
  return value === "created" || value === "prompted" ? value : undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readLabelIds(value: Record<string, unknown>): string[] | undefined {
  const direct = value["labelIds"];
  if (Array.isArray(direct) && direct.every((candidate) => typeof candidate === "string")) {
    return direct;
  }
  const labels = value["labels"];
  const nodes = Array.isArray(labels) ? labels : asRecord(labels)?.["nodes"];
  if (!Array.isArray(nodes)) return undefined;
  return nodes.flatMap((candidate) => {
    const id = readString(asRecord(candidate)?.["id"]);
    return id === undefined ? [] : [id];
  });
}

function readNullableId(
  value: Record<string, unknown> | undefined,
  key: string,
): string | null | undefined {
  if (value === undefined || !hasOwn(value, key)) return undefined;
  return readNullableString(value[key]);
}

function readNullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readDate(value: unknown): string | undefined {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value)))
    return new Date(value).toISOString();
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
