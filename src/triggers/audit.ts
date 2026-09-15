import type { Logger } from "pino";
import type { ProviderEventAcceptance } from "../db/types.js";
import { logger } from "../logger.js";

type EventAuditLogger = Pick<Logger, "info">;

export function logProviderEventIntake(input: {
  provider: "github" | "slack" | "discord" | "linear";
  source: string;
  deliveryId: string;
  acceptance: ProviderEventAcceptance;
  repository?: string | undefined;
  resourceId?: string | undefined;
  /** The transport `linear-delivery` header when the durable delivery id is semantic. */
  transportDeliveryId?: string | undefined;
  /** The follow-up routing outcome of a Linear `prompted` activity. */
  followUp?: string | undefined;
  log?: EventAuditLogger;
}): void {
  const acceptance = input.acceptance;
  (input.log ?? logger).info(
    {
      provider: input.provider,
      source: input.source,
      deliveryId: input.deliveryId,
      receiptId: acceptance.receiptId,
      outcome: acceptance.status,
      ...(acceptance.status === "accepted" ? { routeCount: acceptance.events.length } : {}),
      ...(acceptance.status === "dropped" ? { reason: acceptance.reason } : {}),
      ...(input.repository === undefined ? {} : { repository: input.repository }),
      ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
      ...(input.transportDeliveryId === undefined
        ? {}
        : { transportDeliveryId: input.transportDeliveryId }),
      ...(input.followUp === undefined ? {} : { followUp: input.followUp }),
      ...(acceptance.status === "accepted" && acceptance.replayed === true
        ? { replayed: true }
        : {}),
    },
    "provider event intake completed",
  );
}

export function logProviderEventRouting(input: {
  source: string;
  deliveryId: string;
  receiptId: string;
  projectId: string;
  triggerNames: readonly string[];
  acceptedCount: number;
  rejectedCount: number;
  dropReason?: string | undefined;
  log?: EventAuditLogger;
}): void {
  (input.log ?? logger).info(
    {
      source: input.source,
      deliveryId: input.deliveryId,
      receiptId: input.receiptId,
      projectId: input.projectId,
      outcome: input.dropReason === undefined ? "matched" : "dropped",
      ...(input.dropReason === undefined
        ? {
            triggerNames: input.triggerNames,
            acceptedCount: input.acceptedCount,
            rejectedCount: input.rejectedCount,
          }
        : { reason: input.dropReason }),
    },
    "provider event routing completed",
  );
}
