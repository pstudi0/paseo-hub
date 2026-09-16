import type { AuthServer } from "../../auth/server.js";
import {
  CONNECTION_ATTEMPT_LIFETIME_MINUTES,
  CONNECTIONS_RETURN_ROUTE,
  callbackConnectionAccess,
  cancelledConnectionResult,
  connectionAccess,
  connectionActionFailure,
  connectionCallbackFailure,
  connectionResult,
  manageConnectionAccess,
  newConnectionState,
  requiredConnectionId,
  stateHash,
} from "../../connections/shared.js";
import { DatabaseUnavailableError } from "../../db/errors.js";
import type {
  BindLinearConnectionInput,
  Database,
  LinearConnectionRecord,
} from "../../db/types.js";
import { outputContextProvider, replyOutputTool } from "../../execution-capabilities/outputs.js";
import { logger } from "../../logger.js";
import type { ExecutionControl } from "../../daemons/execution-control.js";
import {
  LINEAR_OUTPUT_TOOLS,
  createLinearAgentOutputExecutors,
  linearAgentSessionAvailable,
} from "../../triggers/linear/agent-outputs.js";
import { createLinearMirror } from "../../triggers/linear/mirror.js";
import { createLinearTriggerProvider } from "../../triggers/linear/provider.js";
import { createLinearReplyExecutor } from "../../triggers/linear/reply.js";
import { LinearSessionCoordinator } from "../../triggers/linear/session-coordinator.js";
import type { LinearSessionState } from "../../triggers/linear/session-state.js";
import {
  createLinearWebhookSource,
  type LinearWebhookSourceOptions,
} from "../../triggers/linear/webhook.js";
import type { ProviderOutputRegistration } from "../registration.js";
import type { ProviderConnectionRegistration, ProviderRegistration } from "../registration.js";
import {
  createLinearApiClient,
  createLinearConnectionClient,
  linearConnectionRequiresReauthorization,
  type LinearApiClient,
  type LinearConnectionClient,
  type LinearInstallation,
} from "./client.js";

export interface LinearRegistrationConfiguration {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
}

export interface CreateLinearRegistrationOptions {
  database: Database | null;
  auth: AuthServer | null;
  applicationBaseUrl: string;
  publicBaseUrl?: string;
  environment?: NodeJS.ProcessEnv;
  configuration?: LinearRegistrationConfiguration | null;
  connectionClient?: LinearConnectionClient;
  apiClient?: LinearApiClient;
  /** Agent-session queues shared across registrations; sessions are disabled without it. */
  sessionState?: LinearSessionState;
  executionControl?: ExecutionControl;
  fetch?: typeof fetch;
  configurationVersion?: number;
  expectedConfigurationVersion?: number;
  activateConfiguration?: boolean;
  onVerifiedInstallation?: (input: {
    configuration: unknown;
    expectedConfigurationVersion: number | undefined;
    callbackOrigin: string;
    userId: string;
    installation: LinearInstallation;
    binding: BindLinearConnectionInput;
  }) => Promise<void>;
}

interface LinearConnectionOptions {
  database: Database;
  auth: AuthServer;
  applicationBaseUrl: string;
  callbackOrigin: string;
  configurationVersion: number;
  configuration: LinearRegistrationConfiguration;
  expectedConfigurationVersion: number | undefined;
  activateConfiguration: boolean;
  onVerifiedInstallation: CreateLinearRegistrationOptions["onVerifiedInstallation"];
}

export function createLinearRegistration(
  options: CreateLinearRegistrationOptions,
): ProviderRegistration {
  const configuration = options.configuration ?? null;
  if (configuration === null || options.publicBaseUrl === undefined) {
    return emptyLinearRegistration(options);
  }
  const connectionClient =
    options.connectionClient ??
    createLinearConnectionClient({
      clientId: configuration.clientId,
      clientSecret: configuration.clientSecret,
      publicBaseUrl: options.publicBaseUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  const database = options.database;
  const api = createLinearApi(options, connectionClient);
  const sessions =
    database === null ||
    api === undefined ||
    options.sessionState === undefined ||
    options.executionControl === undefined
      ? undefined
      : createLinearSessions({
          database,
          api,
          state: options.sessionState,
          control: options.executionControl,
          publicBaseUrl: options.publicBaseUrl,
        });
  const accept =
    database === null
      ? () => Promise.reject(new DatabaseUnavailableError())
      : (
          input: Omit<
            Parameters<Database["acceptLinearEvent"]>[0],
            "providerApplicationId" | "providerConfigurationVersion"
          >,
        ) =>
          database.acceptLinearEvent({
            ...input,
            providerApplicationId: configuration.clientId,
            providerConfigurationVersion: options.configurationVersion ?? 0,
          });
  const webhook = createLinearWebhook({
    webhookSecret: configuration.webhookSecret,
    accept,
    database,
    api,
    sessions,
  });
  if (database === null) {
    return {
      connection: linearConnectionStatus(true),
      triggerProviders: [],
      sources: [webhook],
      outputs: [],
      requests: [{ name: "linear.events", handle: (request) => webhook.handle(request) }],
    };
  }
  const connection =
    options.auth === null
      ? linearConnectionStatus(true)
      : createLinearConnection(
          {
            database,
            auth: options.auth,
            applicationBaseUrl: options.applicationBaseUrl,
            callbackOrigin: options.publicBaseUrl,
            configurationVersion: options.configurationVersion ?? 0,
            configuration,
            expectedConfigurationVersion: options.expectedConfigurationVersion,
            activateConfiguration: options.activateConfiguration ?? false,
            onVerifiedInstallation: options.onVerifiedInstallation,
          },
          connectionClient,
        );
  return {
    configurationSnapshot: {
      version: options.configurationVersion ?? 0,
      callbackOrigin: options.publicBaseUrl,
    },
    connection,
    ...(api === undefined ? {} : { integration: linearIntegration(database, api) }),
    triggerProviders: [
      ({ configurationStoreForProject }) =>
        createLinearTriggerProvider({
          configurationStoreForProject,
          ...(api === undefined ? {} : { client: api }),
          ...(sessions === undefined
            ? {}
            : {
                session: {
                  coordinator: sessions.coordinator,
                  mirror: sessions.mirror,
                  database,
                  client: api,
                },
              }),
        }),
    ],
    sources: [webhook],
    outputs:
      api === undefined
        ? []
        : [
            {
              type: "linear.reply",
              tool: replyOutputTool,
              available: outputContextProvider("linear"),
              execute: createLinearReplyExecutor({ client: api }),
            },
            ...(sessions === undefined ? [] : sessions.outputs),
          ],
    requests: [{ name: "linear.events", handle: (request) => webhook.handle(request) }],
  };
}

function createLinearApi(
  options: CreateLinearRegistrationOptions,
  connectionClient: LinearConnectionClient,
): LinearApiClient | undefined {
  const database = options.database;
  if (database === null) return undefined;
  return (
    options.apiClient ??
    createLinearApiClient({
      connectionForLinearOrganization: (linearOrganizationId) =>
        database.findLinearConnection(linearOrganizationId),
      withLinearConnectionRefresh: database.withLinearConnectionRefresh.bind(database),
      connectionClient,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })
  );
}

function createLinearWebhook(input: {
  webhookSecret: string;
  accept: LinearWebhookSourceOptions["accept"];
  database: Database | null;
  api: LinearApiClient | undefined;
  sessions: ReturnType<typeof createLinearSessions> | undefined;
}): ReturnType<typeof createLinearWebhookSource> {
  const { database, api, sessions } = input;
  return createLinearWebhookSource({
    signingSecret: input.webhookSecret,
    accept: input.accept,
    ...(database === null
      ? {}
      : {
          canHydrateIssue: async (linearOrganizationId) => {
            const connection = await database.findLinearConnection(linearOrganizationId);
            return connection !== undefined && !linearConnectionRequiresReauthorization(connection);
          },
        }),
    ...(api === undefined
      ? {}
      : {
          resolveIssue: ({ linearOrganizationId, issueId }) =>
            api.readIssue({ linearOrganizationId, issueId }),
        }),
    ...(sessions === undefined || database === null
      ? {}
      : {
          sessions: sessions.coordinator,
          lifecycle: {
            claim: (claimInput) => database.claimLinearLifecycleReceipt(claimInput),
            apply: (event, claim) => sessions.coordinator.applyLifecycle(event, claim),
          },
        }),
  });
}

function createLinearSessions(input: {
  database: Database;
  api: LinearApiClient;
  state: LinearSessionState;
  control: ExecutionControl;
  publicBaseUrl: string;
}): {
  coordinator: LinearSessionCoordinator;
  mirror: ReturnType<typeof createLinearMirror>;
  outputs: ProviderOutputRegistration[];
} {
  input.state.client = input.api;
  const coordinator = new LinearSessionCoordinator({
    state: input.state,
    control: input.control,
    database: input.database,
    publicBaseUrl: input.publicBaseUrl,
  });
  const mirror = createLinearMirror({
    coordinator,
    database: input.database,
    control: input.control,
  });
  const executors = createLinearAgentOutputExecutors({ coordinator, database: input.database });
  const outputs: ProviderOutputRegistration[] = (
    [
      ["linear.response", executors.response],
      ["linear.ask", executors.ask],
      ["linear.plan", executors.plan],
      ["linear.link", executors.link],
      ["linear.comment", executors.comment],
      ["linear.status", executors.status],
    ] as const
  ).map(([type, execute]) => ({
    type,
    tool: LINEAR_OUTPUT_TOOLS[type],
    available: linearAgentSessionAvailable,
    execute,
  }));
  return { coordinator, mirror, outputs };
}

function emptyLinearRegistration(
  options: Pick<CreateLinearRegistrationOptions, "database" | "auth" | "applicationBaseUrl">,
): ProviderRegistration {
  const connection =
    options.database === null || options.auth === null
      ? linearConnectionStatus(false)
      : createLinearConnection(
          {
            database: options.database,
            auth: options.auth,
            applicationBaseUrl: options.applicationBaseUrl,
            callbackOrigin: options.applicationBaseUrl,
            configurationVersion: 0,
            configuration: {
              clientId: "unconfigured",
              clientSecret: "unconfigured",
              webhookSecret: "unconfigured",
            },
            expectedConfigurationVersion: undefined,
            activateConfiguration: false,
            onVerifiedInstallation: undefined,
          },
          undefined,
        );
  return { connection, triggerProviders: [], sources: [], outputs: [], requests: [] };
}

function linearConnectionStatus(configured: boolean): ProviderConnectionRegistration {
  return {
    name: "linear",
    status: (connections) => linearStatus(configured, connections.linear),
    actions: {},
  };
}

function createLinearConnection(
  options: LinearConnectionOptions,
  client: LinearConnectionClient | undefined,
): ProviderConnectionRegistration {
  const start = async (request: Request): Promise<Response> => {
    if (!isHttpsCallbackOrigin(options.callbackOrigin)) {
      return Response.json({ error: "https_required" }, { status: 400 });
    }
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(options.auth, options.database, request);
      if (client === undefined)
        return Response.json({ error: "provider_not_configured" }, { status: 409 });
      const state = newConnectionState();
      await options.database.startConnectionAttempt({
        provider: "linear",
        stateVerifier: stateHash(state),
        access: connectionAccess(access),
        lifetimeMinutes: CONNECTION_ATTEMPT_LIFETIME_MINUTES,
        callbackOrigin: options.callbackOrigin,
        configurationVersion: options.configurationVersion,
        providerApplicationId: options.configuration.clientId,
        configurationSnapshot: { provider: "linear", ...options.configuration },
        expectedConfigurationVersion: options.expectedConfigurationVersion ?? null,
        activateConfiguration: options.activateConfiguration,
      });
      return Response.json({ url: client.authorizationUrl(state) });
    } catch (error) {
      return connectionActionFailure(error, "linear", "start");
    }
  };

  const disconnect = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(options.auth, options.database, request);
      const disconnected = await options.database.disconnectConnection(
        "linear",
        requiredConnectionId(request),
        connectionAccess(access),
      );
      if (disconnected.provider === "linear" && disconnected.accessToken !== undefined) {
        void client
          ?.revoke(disconnected.accessToken, disconnected.refreshToken)
          .catch((error: unknown) => {
            logger.warn(
              { err: error, provider: "linear" },
              "provider cleanup failed after disconnect",
            );
          });
      }
      return Response.json({ disconnected: true });
    } catch (error) {
      return connectionActionFailure(error, "linear", "disconnect");
    }
  };

  return {
    name: "linear",
    status: (connections) => linearStatus(client !== undefined, connections.linear),
    actions: {
      start,
      disconnect,
      callback: (request) => completeAuthorization(options, client, request),
    },
  };
}

function isHttpsCallbackOrigin(value: string): boolean {
  try {
    const origin = new URL(value);
    return origin.protocol === "https:" && origin.username === "" && origin.password === "";
  } catch {
    return false;
  }
}

async function completeAuthorization(
  options: LinearConnectionOptions,
  client: LinearConnectionClient | undefined,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (state !== null && code === null && url.searchParams.get("error") === "access_denied") {
    return cancelledConnectionResult({
      auth: options.auth,
      database: options.database,
      request,
      provider: "linear",
      phase: "linear_authorization",
      state,
      applicationBaseUrl: options.applicationBaseUrl,
    });
  }
  if (state === null || code === null || client === undefined) {
    return connectionCallbackFailure({
      request,
      error: new LinearCallbackError(),
      provider: "linear",
      phase: "authorization",
      applicationBaseUrl: options.applicationBaseUrl,
      returnRoute: CONNECTIONS_RETURN_ROUTE,
    });
  }
  let returnRoute: string = CONNECTIONS_RETURN_ROUTE;
  let callbackOrigin = options.applicationBaseUrl;
  try {
    const access = await callbackConnectionAccess(options.auth, request);
    const attempt = await options.database.readConnectionAttempt({
      stateVerifier: stateHash(state),
      phase: "linear_authorization",
      access,
    });
    returnRoute = attempt.returnRoute;
    callbackOrigin = attempt.callbackOrigin;
    const installation = await client.exchangeCode(code);
    const binding = linearBinding(state, access, installation, options.configuration.clientId);
    if (attempt.activateConfiguration) {
      if (options.onVerifiedInstallation === undefined) {
        throw new Error("Linear installation handler unavailable");
      }
      await options.onVerifiedInstallation({
        configuration: attempt.configurationSnapshot,
        expectedConfigurationVersion: attempt.expectedConfigurationVersion ?? undefined,
        callbackOrigin: attempt.callbackOrigin,
        userId: attempt.userId,
        installation,
        binding,
      });
    } else {
      await options.database.bindLinearConnection(binding);
    }
    return connectionResult(callbackOrigin, attempt.returnRoute, "linear_connected", "linear");
  } catch (error) {
    return connectionCallbackFailure({
      request,
      error,
      provider: "linear",
      phase: "authorization",
      applicationBaseUrl: callbackOrigin,
      returnRoute,
    });
  }
}

class LinearCallbackError extends Error {
  readonly code = "invalidInput";
  constructor() {
    super("invalid Linear callback");
  }
}

function linearBinding(
  state: string,
  access: Awaited<ReturnType<typeof callbackConnectionAccess>>,
  installation: LinearInstallation,
  providerApplicationId: string,
): BindLinearConnectionInput {
  return {
    stateVerifier: stateHash(state),
    phase: "linear_authorization",
    access,
    providerApplicationId,
    ...installation,
  };
}

function linearStatus(configured: boolean, bindings: readonly LinearConnectionRecord[]) {
  if (!configured) return { status: "notConfigured" as const };
  if (bindings.length === 0) return { status: "disconnected" as const };
  return bindings.some((binding) => linearConnectionRequiresReauthorization(binding))
    ? { status: "requiresReauthorization" as const }
    : { status: "connected" as const };
}

/**
 * Hands an agent the app's installation token for the run, through the same
 * `${{ paseo.connections.<slug>.token }}` mechanism GitHub already uses, so the agent talks to
 * Linear itself with the agent application's identity.
 *
 * It deliberately does NOT mint a `client_credentials` token per run, although Linear recommends
 * that shape for automation. Revoking such a token through `/oauth/revoke`, authenticated with the
 * application's own client id and secret, revoked the workspace installation itself and left the
 * Hub unable to authenticate at all. Until a token can be retired without taking the installation
 * with it, the run reuses the stored token, which the Hub already refreshes.
 */
function linearIntegration(database: Database, api: LinearApiClient) {
  return {
    async resolve(projectId: string, connectionSlug: string, value: string): Promise<string> {
      if (value !== "token") {
        throw new Error(`unsupported linear integration value: ${value}`);
      }
      const project = await database.findProjectById(projectId);
      const selected =
        project === undefined
          ? undefined
          : (await database.organizationConnectionUsage(project.organizationId)).linear.find(
              (candidate) =>
                candidate.organizationId === project.organizationId &&
                candidate.slug === connectionSlug,
            );
      if (selected === undefined) {
        throw new Error(`linear connection is unavailable: ${connectionSlug}`);
      }
      return api.accessTokenFor(selected.linearOrganizationId);
    },
  };
}
