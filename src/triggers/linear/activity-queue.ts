import type { JsonValue } from "../../config/compiler.js";
import { reportFailure } from "../../failures/index.js";
import {
  LinearApiError,
  type LinearActivityContent,
  type LinearActivitySignal,
  type LinearApiClient,
  type LinearPlanStep,
} from "../../providers/linear/client.js";

export const LINEAR_MIRROR_MIN_INTERVAL_MS = 1_000;
const RATE_LIMIT_DELAYS_MS = [5_000, 30_000, 60_000] as const;
const TERMINAL_ACTIVITY_TYPES = new Set(["response", "error", "elicitation"]);

export type LinearOutboundActivity =
  | {
      kind: "activity";
      id?: string;
      content: LinearActivityContent;
      ephemeral: boolean;
      signal?: LinearActivitySignal;
      signalMetadata?: JsonValue;
      /** Pending ephemeral items sharing a key are replaced by the newest one. */
      coalesceKey?: string;
      /** The acknowledgement skips the pacing interval. */
      priority?: "ack";
    }
  | {
      kind: "session";
      plan?: readonly LinearPlanStep[];
      addedExternalUrls?: readonly { label: string; url: string }[];
      summary?: string;
      coalesceKey?: string;
    };

export type LinearEmitResult = "sent" | "coalesced" | "dropped" | "failed";

export interface LinearActivityQueueOptions {
  sessionId: string;
  linearOrganizationId: string;
  client(): LinearApiClient | undefined;
  /** True while the session's last activity is terminal: non-terminal activities are dropped. */
  silenced(): Promise<boolean>;
  onSent(item: LinearOutboundActivity, activityId: string | undefined): Promise<void>;
  now?: () => number;
  setTimeout?: (callback: () => void, delay: number) => unknown;
}

interface Entry {
  item: LinearOutboundActivity;
  resolve(result: LinearEmitResult): void;
  closeAfter: boolean;
}

/**
 * One sequential outbound queue per Linear agent session: paces mutations, coalesces ephemeral
 * chatter, retries rate limits, stays silent after a terminal activity, and can be closed by a
 * stop until the next dispatch reopens it.
 */
export class LinearActivityQueue {
  private readonly entries: Entry[] = [];
  private draining = false;
  private closed = false;
  private lastSentAt = 0;

  constructor(private readonly options: LinearActivityQueueOptions) {}

  enqueue(
    item: LinearOutboundActivity,
    options: { head?: boolean; closeAfter?: boolean } = {},
  ): Promise<LinearEmitResult> {
    if (this.closed) return Promise.resolve("dropped");
    return new Promise<LinearEmitResult>((resolve) => {
      if (item.coalesceKey !== undefined) {
        const index = this.entries.findIndex(
          (entry) => entry.item.coalesceKey === item.coalesceKey,
        );
        if (index !== -1) {
          this.entries[index]!.resolve("coalesced");
          this.entries.splice(index, 1);
        }
      }
      const entry: Entry = { item, resolve, closeAfter: options.closeAfter === true };
      if (options.head === true) this.entries.unshift(entry);
      else this.entries.push(entry);
      void this.drain();
    });
  }

  /** Removes every pending non-terminal item (a stop discards chatter, never a final answer). */
  purge(): void {
    for (const entry of this.entries.splice(0)) {
      if (isTerminal(entry.item)) this.entries.push(entry);
      else entry.resolve("dropped");
    }
  }

  reopen(): void {
    this.closed = false;
  }

  get pending(): number {
    return this.entries.length;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let entry: Entry | undefined;
      while ((entry = this.entries.shift()) !== undefined) {
        const result = await this.send(entry.item);
        entry.resolve(result);
        if (entry.closeAfter && result === "sent") {
          this.closed = true;
          for (const remaining of this.entries.splice(0)) remaining.resolve("dropped");
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async send(item: LinearOutboundActivity): Promise<LinearEmitResult> {
    if (item.kind === "activity" && !isTerminal(item) && (await this.options.silenced())) {
      return "dropped";
    }
    await this.pace(item);
    let attempt = 0;
    for (;;) {
      const client = this.options.client();
      if (client === undefined) return this.fail(item, new Error("Linear client unavailable"));
      try {
        const activityId = await this.mutate(client, item);
        this.lastSentAt = this.now();
        await this.options.onSent(item, activityId);
        return "sent";
      } catch (error) {
        const delay = rateLimitDelay(error, attempt);
        if (delay === undefined) return this.fail(item, error);
        attempt += 1;
        await this.sleep(delay);
      }
    }
  }

  private async mutate(
    client: LinearApiClient,
    item: LinearOutboundActivity,
  ): Promise<string | undefined> {
    if (item.kind === "activity") {
      const created = await client.createAgentActivity({
        linearOrganizationId: this.options.linearOrganizationId,
        agentSessionId: this.options.sessionId,
        ...(item.id === undefined ? {} : { id: item.id }),
        content: item.content,
        ephemeral: item.ephemeral,
        ...(item.signal === undefined ? {} : { signal: item.signal }),
        ...(item.signalMetadata === undefined ? {} : { signalMetadata: item.signalMetadata }),
      });
      return created.id;
    }
    await client.updateAgentSession({
      linearOrganizationId: this.options.linearOrganizationId,
      agentSessionId: this.options.sessionId,
      ...(item.plan === undefined ? {} : { plan: item.plan }),
      ...(item.addedExternalUrls === undefined
        ? {}
        : { addedExternalUrls: item.addedExternalUrls }),
      ...(item.summary === undefined ? {} : { summary: item.summary }),
    });
    return undefined;
  }

  private fail(item: LinearOutboundActivity, error: unknown): LinearEmitResult {
    reportFailure(
      error,
      { component: "triggers", operation: "linear.mirror.emit", provider: "linear" },
      {
        diagnostic: {
          sessionId: this.options.sessionId,
          kind: describe(item),
          // Linear's validation message names the rejected field; it never echoes the body.
          ...(error instanceof LinearApiError ? { linearMessage: error.message } : {}),
          ...(item.kind === "activity" && item.content.type === "action"
            ? { action: item.content.action, parameterLength: item.content.parameter.length }
            : {}),
        },
      },
    );
    return isTerminal(item) ? "failed" : "dropped";
  }

  private async pace(item: LinearOutboundActivity): Promise<void> {
    if (item.kind === "activity" && item.priority === "ack") return;
    const wait = this.lastSentAt + LINEAR_MIRROR_MIN_INTERVAL_MS - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    const timer = this.options.setTimeout ?? globalThis.setTimeout;
    return new Promise((resolve) => {
      timer(() => resolve(), ms);
    });
  }
}

export function isTerminal(item: LinearOutboundActivity): boolean {
  return item.kind === "activity" && TERMINAL_ACTIVITY_TYPES.has(item.content.type);
}

function describe(item: LinearOutboundActivity): string {
  return item.kind === "activity" ? item.content.type : "session";
}

function rateLimitDelay(error: unknown, attempt: number): number | undefined {
  if (!(error instanceof LinearApiError)) return undefined;
  if (error.status !== 429 && error.code !== "RATELIMITED") return undefined;
  if (attempt >= RATE_LIMIT_DELAYS_MS.length) return undefined;
  if (attempt === 0 && error.retryAfterMs !== undefined) return error.retryAfterMs;
  return RATE_LIMIT_DELAYS_MS[attempt];
}
