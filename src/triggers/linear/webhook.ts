import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { DurableProviderEvent, ProviderEventAcceptance } from "../../db/types.js";
import { readBoundedRequestBody } from "../../http/request-body.js";
import { reportFailure } from "../../failures/index.js";
import { logger } from "../../logger.js";
import { logProviderEventIntake } from "../audit.js";
import { isProviderEventDropReasonCode, type ProviderEventDropReasonCode } from "../drop-reason.js";
import type { TriggerHandler, TriggerSource } from "../index.js";
import {
  eventIssueId,
  eventRouteResourceId,
  normalizeLinearEvent,
  type NormalizedLinearAgentSessionEvent,
} from "./events.js";
import { parseLinearLifecycleEvent, type LinearLifecycleEvent } from "./lifecycle-events.js";
import type { LinearSessionCoordinator } from "./session-coordinator.js";
import type { LinearIssueDetails } from "../../providers/linear/client.js";
import type {
  LinearLifecycleReceiptClaim,
  LinearLifecycleReceiptClaimInput,
} from "../../db/types.js";

const MAX_WEBHOOK_BYTES = 1_048_576;
const MAX_TIMESTAMP_SKEW_MS = 60_000;

export interface LinearWebhookSourceOptions {
  signingSecret: string;
  now?: () => number;
  canHydrateIssue?(linearOrganizationId: string): Promise<boolean>;
  resolveIssue?(input: {
    linearOrganizationId: string;
    issueId: string;
  }): Promise<LinearIssueDetails | undefined>;
  accept(input: {
    linearOrganizationId: string;
    /** Route selector persisted as the receipt `resource_id` (project for issues, team for sessions). */
    resourceId?: string;
    deliveryId: string;
    signatureHash: string;
    source: string;
    payload: unknown;
    receivedAt: Date;
    dropReason?: ProviderEventDropReasonCode;
  }): Promise<ProviderEventAcceptance>;
  /** Agent-session acknowledgement and follow-up routing; sessions are ignored without it. */
  sessions?: Pick<
    LinearSessionCoordinator,
    "acknowledge" | "followUp" | "reportDrop" | "reportDispatchFailure"
  >;
  /** Permission changes, revocation and inbox notifications; ignored without it. */
  lifecycle?: {
    claim(input: LinearLifecycleReceiptClaimInput): Promise<LinearLifecycleReceiptClaim>;
    /**
     * Returns a session prompt when the lifecycle event is really a message for the agent, so it
     * reaches the issue's existing session instead of opening another one.
     */
    apply(
      event: LinearLifecycleEvent,
      claim: Extract<LinearLifecycleReceiptClaim, { status: "claimed" }>,
    ): Promise<NormalizedLinearAgentSessionEvent | undefined>;
  };
}

export interface LinearWebhookEndpoint extends TriggerSource {
  handle(request: Request): Promise<Response>;
}

interface VerifiedLinearRequest {
  deliveryId: string;
  eventName: string | null;
  payload: unknown;
  signatureHash: string;
  receivedAt: Date;
}

export function createLinearWebhookSource(
  options: LinearWebhookSourceOptions,
): LinearWebhookEndpoint {
  const handlers = new Set<TriggerHandler>();
  return {
    async handle(request) {
      const verified = await verifyLinearRequest(request, options);
      if (verified instanceof Response) return verified;
      return handoffLinearEvent(verified, handlers, options);
    },
    async start(handler) {
      handlers.add(handler);
    },
    async stop() {
      handlers.clear();
    },
  };
}

async function verifyLinearRequest(
  request: Request,
  options: Pick<LinearWebhookSourceOptions, "signingSecret" | "now">,
): Promise<VerifiedLinearRequest | Response> {
  const deliveryId = request.headers.get("linear-delivery");
  const signature = request.headers.get("linear-signature");
  if (deliveryId === null || signature === null) {
    logger.warn("rejecting Linear event because signature evidence is missing");
    return new Response("Unauthorized", { status: 401 });
  }
  const body = await readBoundedRequestBody(request, MAX_WEBHOOK_BYTES);
  if (body instanceof Response) return body;
  const normalizedSignature = canonicalLinearSignature(signature);
  if (
    normalizedSignature === undefined ||
    !verifyLinearSignature(options.signingSecret, body, normalizedSignature)
  ) {
    logger.warn("rejecting Linear event because signature verification failed");
    return new Response("Unauthorized", { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    logger.warn("rejecting Linear event because payload is invalid JSON");
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const receivedAt = new Date(options.now?.() ?? Date.now());
  if (!verifyLinearWebhookTimestamp(payload, receivedAt.getTime())) {
    logger.warn("rejecting Linear event because its signed webhook timestamp is stale or invalid");
    return new Response("Unauthorized", { status: 401 });
  }
  return {
    deliveryId,
    eventName: request.headers.get("linear-event"),
    payload,
    signatureHash: createHash("sha256").update(normalizedSignature).digest("hex"),
    receivedAt,
  };
}

async function handoffLinearEvent(
  verified: VerifiedLinearRequest,
  handlers: Set<TriggerHandler>,
  options: LinearWebhookSourceOptions,
): Promise<Response> {
  try {
    const lifecycle = parseLinearLifecycleEvent(verified.eventName, verified.payload);
    if (lifecycle !== undefined)
      return await applyLinearLifecycle(lifecycle, verified, handlers, options);
    let event = normalizeLinearEvent(verified.payload, verified.eventName);
    if (event === undefined) {
      logger.info({ deliveryId: verified.deliveryId }, "ignoring unsupported Linear event");
      return new Response("OK", { status: 200 });
    }
    // A session is routed by its issue's team; without an issue there is nothing to hydrate,
    // serve, or retry.
    if (event.type === "agent_session") {
      if (event.session.issue === null) {
        logger.info(
          { deliveryId: verified.deliveryId, agentSessionId: event.session.id },
          "ignoring Linear agent session without issue",
        );
        return new Response("OK", { status: 200 });
      }
      return await acceptAndDispatchLinearSession(
        { ...event, transportDeliveryId: verified.deliveryId },
        verified,
        handlers,
        options,
      );
    }
    if (eventRouteResourceId(event) === undefined && options.resolveIssue !== undefined) {
      const source = linearEventSource(event);
      if (
        options.canHydrateIssue !== undefined &&
        !(await options.canHydrateIssue(event.organizationId))
      ) {
        return await acceptAndDispatchLinearEvent(event, source, verified, handlers, options, true);
      }
      const issue = await options.resolveIssue({
        linearOrganizationId: event.organizationId,
        issueId: eventIssueId(event),
      });
      event = normalizeLinearEvent(verified.payload, verified.eventName, issue);
    }
    if (event === undefined) {
      logger.warn({ deliveryId: verified.deliveryId }, "Linear event issue hydration was invalid");
      return Response.json({ error: "invalid_linear_event" }, { status: 400 });
    }
    return await acceptAndDispatchLinearEvent(
      event,
      linearEventSource(event),
      verified,
      handlers,
      options,
    );
  } catch (error) {
    logger.error({ err: error, deliveryId: verified.deliveryId }, "Linear event handoff failed");
    return Response.json({ error: "event_handoff_unavailable" }, { status: 503 });
  }
}

async function acceptAndDispatchLinearEvent(
  event: NonNullable<ReturnType<typeof normalizeLinearEvent>>,
  source: LinearEventSource,
  verified: VerifiedLinearRequest,
  handlers: Set<TriggerHandler>,
  options: LinearWebhookSourceOptions,
  preserveBindingDrop = false,
): Promise<Response> {
  const resourceId = eventRouteResourceId(event);
  const acceptance = await options.accept({
    linearOrganizationId: event.organizationId,
    ...(resourceId === undefined ? {} : { resourceId }),
    deliveryId: verified.deliveryId,
    signatureHash: verified.signatureHash,
    source,
    payload: event,
    receivedAt: verified.receivedAt,
    ...(handlers.size === 0 && !preserveBindingDrop
      ? { dropReason: "configuration_unavailable" }
      : {}),
  });
  logProviderEventIntake({
    provider: "linear",
    source,
    deliveryId: verified.deliveryId,
    resourceId,
    acceptance,
  });
  const events = acceptance.status === "accepted" ? acceptance.events : [];
  await Promise.all(
    events.flatMap((acceptedEvent) => Array.from(handlers, (handler) => handler(acceptedEvent))),
  );
  return new Response("OK", { status: 200 });
}

/**
 * The agent-session path never awaits Linear or a daemon: Linear expects the HTTP answer within
 * five seconds and the first activity within ten. Deduplication is by entity (`session.id` for
 * `created`, `activity.id` for `prompted`) because every Linear retry is re-signed and re-stamped.
 */
async function acceptAndDispatchLinearSession(
  event: NormalizedLinearAgentSessionEvent,
  verified: VerifiedLinearRequest,
  handlers: Set<TriggerHandler>,
  options: LinearWebhookSourceOptions,
): Promise<Response> {
  const source = "linear.agent_session";
  const resourceId = eventRouteResourceId(event);
  const deliveryId =
    event.action === "created"
      ? `linear-agent-session:${event.session.id}`
      : `linear-agent-activity:${event.id}`;
  const acceptance = await options.accept({
    linearOrganizationId: event.organizationId,
    ...(resourceId === undefined ? {} : { resourceId }),
    deliveryId,
    signatureHash: verified.signatureHash,
    source,
    payload: event,
    receivedAt: verified.receivedAt,
    ...(handlers.size === 0 ? { dropReason: "configuration_unavailable" } : {}),
  });
  const followUp = await routeLinearSession(event, acceptance, options);
  logProviderEventIntake({
    provider: "linear",
    source,
    deliveryId,
    resourceId,
    acceptance,
    transportDeliveryId: verified.deliveryId,
    ...(followUp === undefined ? {} : { followUp }),
  });
  if (shouldDispatchLinearSession(event, acceptance, followUp)) {
    await dispatchLinearSession(event, acceptance.events, handlers, options);
  }
  return new Response("OK", { status: 200 });
}

/** Acknowledges a new session or routes a follow-up; returns the follow-up outcome, if any. */
async function routeLinearSession(
  event: NormalizedLinearAgentSessionEvent,
  acceptance: ProviderEventAcceptance,
  options: LinearWebhookSourceOptions,
): Promise<string | undefined> {
  if (acceptance.status === "dropped") {
    const reason = acceptance.reason;
    if (isProviderEventDropReasonCode(reason)) options.sessions?.reportDrop(event, reason);
    return undefined;
  }
  if (acceptance.status !== "accepted" || acceptance.replayed === true) return undefined;
  const first = acceptance.events[0];
  if (first === undefined || options.sessions === undefined) return undefined;
  const input = { connectionId: first.connectionId ?? "", organizationId: first.organizationId };
  if (event.action === "prompted") return options.sessions.followUp(event, input);
  try {
    await options.sessions.acknowledge(event, input);
  } catch (error) {
    reportFailure(error, {
      component: "triggers",
      operation: "linear.agent_session.acknowledge",
      provider: "linear",
    });
  }
  return undefined;
}

function shouldDispatchLinearSession(
  event: NormalizedLinearAgentSessionEvent,
  acceptance: ProviderEventAcceptance,
  followUp: string | undefined,
): acceptance is Extract<ProviderEventAcceptance, { status: "accepted" }> {
  if (acceptance.status !== "accepted") return false;
  // A replayed `created` re-runs idempotent handlers; a replayed `prompted` is never re-routed.
  if (event.action === "created") return true;
  return acceptance.replayed !== true && (followUp === undefined || followUp === "dispatch");
}

async function dispatchLinearSession(
  event: NormalizedLinearAgentSessionEvent,
  events: readonly DurableProviderEvent[],
  handlers: Set<TriggerHandler>,
  options: LinearWebhookSourceOptions,
): Promise<void> {
  const settled = await Promise.allSettled(
    events.flatMap((acceptedEvent) => Array.from(handlers, (handler) => handler(acceptedEvent))),
  );
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected === undefined) return;
  reportFailure(rejected.reason, {
    component: "triggers",
    operation: "linear.agent_session.dispatch",
    provider: "linear",
  });
  options.sessions?.reportDispatchFailure(event);
}

async function applyLinearLifecycle(
  event: LinearLifecycleEvent,
  verified: VerifiedLinearRequest,
  handlers: Set<TriggerHandler>,
  options: LinearWebhookSourceOptions,
): Promise<Response> {
  if (options.lifecycle === undefined) {
    logger.info(
      { deliveryId: verified.deliveryId, kind: event.kind },
      "ignoring Linear lifecycle event",
    );
    return new Response("OK", { status: 200 });
  }
  const claim = await options.lifecycle.claim({
    linearOrganizationId: event.organizationId,
    deliveryId: verified.deliveryId,
    signatureHash: verified.signatureHash,
    source: `linear.${event.kind}`,
    payload: verified.payload,
    receivedAt: verified.receivedAt,
  });
  if (claim.status !== "claimed") {
    logger.info(
      { deliveryId: verified.deliveryId, kind: event.kind, outcome: claim.status },
      "Linear lifecycle event not applied",
    );
    return new Response("OK", { status: 200 });
  }
  const prompt = await options.lifecycle.apply(event, claim);
  if (prompt === undefined) return new Response("OK", { status: 200 });
  return acceptAndDispatchLinearSession(prompt, verified, handlers, options);
}

type LinearEventSource = "linear.issue" | "linear.comment" | "linear.agent_session";

function linearEventSource(
  event: NonNullable<ReturnType<typeof normalizeLinearEvent>>,
): LinearEventSource {
  if (event.type === "issue") return "linear.issue";
  if (event.type === "comment") return "linear.comment";
  return "linear.agent_session";
}

/** Verify Linear's HMAC-SHA256 over the exact raw request body. */
export function verifyLinearSignature(
  secret: string,
  body: string | Uint8Array,
  signature: string,
): boolean {
  const normalizedSignature = canonicalLinearSignature(signature);
  if (normalizedSignature === undefined) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(normalizedSignature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A verified signature's spelling is not evidence; its normalized bytes are. */
function canonicalLinearSignature(signature: string): string | undefined {
  const unprefixed = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  return /^[a-f0-9]{64}$/iu.test(unprefixed) ? unprefixed.toLowerCase() : undefined;
}

/** The timestamp is inside the HMAC-protected body, so it can safely prevent replay. */
export function verifyLinearWebhookTimestamp(
  payload: unknown,
  nowMilliseconds = Date.now(),
): boolean {
  if (!isRecord(payload)) return false;
  const timestampMilliseconds = parseLinearWebhookTimestamp(payload["webhookTimestamp"]);
  return (
    timestampMilliseconds !== undefined &&
    Math.abs(nowMilliseconds - timestampMilliseconds) <= MAX_TIMESTAMP_SKEW_MS
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLinearWebhookTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return undefined;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) ? timestamp : undefined;
}
