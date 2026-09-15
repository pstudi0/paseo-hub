import { z } from "zod";
import type { Database, LinearConnectionRecord } from "../../db/types.js";

/**
 * The authority a Linear agent needs: read issues, update them (state, delegate, attachments),
 * leave comments, and be delegated to or mentioned as an app user. One set gates every
 * connection: a workspace authorized with fewer scopes reports `requiresReauthorization` and its
 * events are dropped until an administrator connects it again.
 */
export const LINEAR_REQUIRED_SCOPES = [
  "read",
  "write",
  "comments:create",
  "app:assignable",
  "app:mentionable",
] as const;

/** Keep an issue description plus its preceding discussion within one bounded context window. */
export const LINEAR_ISSUE_CONTEXT_LIMIT = 50;
export const LINEAR_ISSUE_COMMENT_CONTEXT_LIMIT = LINEAR_ISSUE_CONTEXT_LIMIT - 1;
const LINEAR_ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;

const LinearTokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().finite().positive().optional(),
    // Applications created before December 2023 receive the granted scopes as an array.
    scope: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .passthrough();

const ViewerResponseSchema = z.object({
  data: z.object({
    viewer: z.object({
      id: z.string().min(1),
      organization: z.object({ id: z.string().min(1), name: z.string().min(1) }),
    }),
  }),
});

const GraphqlErrorSchema = z.object({
  errors: z
    .array(
      z.object({
        message: z.string().min(1),
        extensions: z.object({ code: z.string().optional() }).passthrough().optional(),
      }),
    )
    .min(1)
    .optional(),
});

const IssueResponseSchema = z.object({
  data: z.object({
    issue: z
      .object({
        id: z.string().min(1),
        identifier: z.string().min(1).optional(),
        title: z.string(),
        description: z.string().nullable().optional(),
        url: z.string().url().optional(),
        branchName: z.string().min(1).optional(),
        team: z
          .object({ id: z.string().min(1), key: z.string().min(1), name: z.string() })
          .nullable()
          .optional(),
        project: z
          .object({ id: z.string().min(1) })
          .nullable()
          .optional(),
        state: z
          .object({ id: z.string().min(1), name: z.string(), type: z.string().min(1) })
          .nullable()
          .optional(),
        assignee: z
          .object({ id: z.string().min(1) })
          .nullable()
          .optional(),
        delegate: z
          .object({ id: z.string().min(1) })
          .nullable()
          .optional(),
        labels: z.object({ nodes: z.array(z.object({ id: z.string().min(1) })) }),
      })
      .nullable(),
  }),
});

const IssueCommentHistoryResponseSchema = z.object({
  data: z.object({
    comments: z.object({
      nodes: z.array(
        z.object({
          id: z.string().min(1),
          body: z.string(),
          createdAt: z.string().datetime(),
          user: z
            .object({
              id: z.string().min(1),
              name: z.string().min(1).nullable().optional(),
            })
            .nullable()
            .optional(),
        }),
      ),
      pageInfo: z.object({ hasPreviousPage: z.boolean() }),
    }),
  }),
});

const CommentResponseSchema = z.object({
  data: z.object({
    commentCreate: z.object({ success: z.literal(true) }),
  }),
});

const AgentActivityCreateResponseSchema = z.object({
  data: z.object({
    agentActivityCreate: z.object({
      success: z.boolean(),
      agentActivity: z.object({ id: z.string().min(1) }),
    }),
  }),
});

const AgentSessionUpdateResponseSchema = z.object({
  data: z.object({ agentSessionUpdate: z.object({ success: z.boolean() }) }),
});

const LINEAR_AGENT_SESSION_STATUSES = [
  "pending",
  "active",
  "awaitingInput",
  "complete",
  "error",
  "stale",
] as const;

const AgentSessionResponseSchema = z.object({
  data: z.object({
    agentSession: z
      .object({
        id: z.string().min(1),
        status: z.enum(LINEAR_AGENT_SESSION_STATUSES),
        summary: z.string().nullable().optional(),
        url: z.string().nullable().optional(),
        issue: z
          .object({ id: z.string().min(1), identifier: z.string().min(1) })
          .nullable()
          .optional(),
      })
      .nullable(),
  }),
});

export type LinearAgentSessionActivityKind =
  | "prompt"
  | "response"
  | "error"
  | "elicitation"
  | "thought"
  | "action";

/** GraphQL `__typename` of each `AgentActivityContent` member, by the kind Hub names it. */
const ACTIVITY_CONTENT_TYPENAMES: ReadonlyMap<string, LinearAgentSessionActivityKind> = new Map([
  ["AgentActivityPromptContent", "prompt"],
  ["AgentActivityResponseContent", "response"],
  ["AgentActivityErrorContent", "error"],
  ["AgentActivityElicitationContent", "elicitation"],
  ["AgentActivityThoughtContent", "thought"],
  ["AgentActivityActionContent", "action"],
]);

const AgentSessionActivityNodeSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  signal: z.string().nullable().optional(),
  user: z
    .object({ id: z.string().min(1), name: z.string().min(1).nullable().optional() })
    .nullable()
    .optional(),
  content: z.object({ __typename: z.string().min(1), body: z.string().optional() }),
});

const AgentSessionActivitiesResponseSchema = z.object({
  data: z.object({
    agentSession: z
      .object({
        activities: z.object({
          nodes: z.array(AgentSessionActivityNodeSchema),
          pageInfo: z.object({ hasPreviousPage: z.boolean() }),
        }),
      })
      .nullable(),
  }),
});

const TeamStatesResponseSchema = z.object({
  data: z.object({
    team: z
      .object({
        states: z.object({
          nodes: z.array(
            z.object({
              id: z.string().min(1),
              name: z.string(),
              type: z.string().min(1),
              position: z.number().finite(),
            }),
          ),
        }),
      })
      .nullable(),
  }),
});

const IssueUpdateResponseSchema = z.object({
  data: z.object({ issueUpdate: z.object({ success: z.boolean() }) }),
});

const AttachmentLinkResponseSchema = z.object({
  data: z.object({ attachmentLinkGitHubPR: z.object({ success: z.boolean() }) }),
});

/**
 * A Linear API failure, kept distinguishable from Hub-side errors so callers can react to the
 * HTTP status (401/403: reauthorize, 429: back off) or to the GraphQL error code Linear attaches
 * under `extensions.code`. A GraphQL-level error carries the HTTP status of its transport (200).
 */
export class LinearApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, details: { status: number; code?: string }) {
    super(message);
    this.name = "LinearApiError";
    this.status = details.status;
    this.code = details.code;
  }
}

export interface LinearInstallation {
  linearOrganizationId: string;
  linearOrganizationName: string;
  appUserId: string;
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  scopes: string[];
}

export interface LinearTokenRefresh {
  accessToken: string;
  refreshToken?: string | null;
  accessTokenExpiresAt?: Date | null;
  scopes?: string[];
}

export interface LinearConnectionClient {
  authorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<LinearInstallation>;
  refresh(refreshToken: string): Promise<LinearTokenRefresh>;
  /** Revokes the access token and, when one is held, the refresh token as well. */
  revoke(accessToken: string, refreshToken?: string | null): Promise<void>;
}

export interface LinearIssueDetails {
  id: string;
  identifier?: string;
  title: string;
  description: string | null;
  url?: string;
  /** Linear's suggested git branch name for the issue. */
  branchName?: string;
  teamId?: string;
  team?: { id: string; key: string; name: string };
  projectId: string | null;
  stateId: string | null;
  state?: { id: string; name: string; type: string } | null;
  assigneeId: string | null;
  /** The agent user the issue is delegated to; null when nobody is. */
  delegateId?: string | null;
  labelIds: string[];
}

/**
 * The activity payloads an agent emits, as Linear documents them
 * (https://linear.app/developers/agent-interaction#activity-content-payload).
 */
export type LinearActivityContent =
  | { type: "thought" | "response" | "error" | "elicitation"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string };

export type LinearActivitySignal = "select" | "auth";

export interface LinearPlanStep {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
}

export type LinearAgentSessionStatus = (typeof LINEAR_AGENT_SESSION_STATUSES)[number];

export interface LinearAgentSession {
  id: string;
  status: LinearAgentSessionStatus;
  summary: string | null;
  url: string | null;
  issue: { id: string; identifier: string } | null;
}

/**
 * One activity read back from a session. Only the conversational kinds carry a body; thoughts and
 * actions are reported by kind so a reader can see they happened without replaying them.
 */
export interface LinearAgentSessionActivity {
  id: string;
  createdAt: string;
  signal: string | null;
  user: { id: string; name?: string } | null;
  content:
    | { kind: "prompt" | "response" | "error" | "elicitation"; body: string }
    | { kind: "thought" | "action" };
}

export interface LinearAgentSessionActivityHistory {
  activities: LinearAgentSessionActivity[];
  complete: boolean;
}

export interface LinearTeamState {
  id: string;
  name: string;
  type: string;
  position: number;
}

export type LinearJsonValue =
  | string
  | number
  | boolean
  | null
  | LinearJsonValue[]
  | { [key: string]: LinearJsonValue };

export interface LinearIssueComment {
  id: string;
  body: string;
  createdAt: string;
  author: { id: string; name?: string } | null;
}

export interface LinearIssueCommentHistory {
  comments: LinearIssueComment[];
  complete: boolean;
}

export interface LinearApiClient {
  readIssue(input: {
    linearOrganizationId: string;
    issueId: string;
  }): Promise<LinearIssueDetails | undefined>;
  readIssueComments(input: {
    linearOrganizationId: string;
    issueId: string;
    beforeCreatedAt: string;
  }): Promise<LinearIssueCommentHistory>;
  createComment(input: {
    linearOrganizationId: string;
    issueId: string;
    body: string;
  }): Promise<void>;
  /**
   * Emits one activity into an agent session. `id` is a UUID v4 the caller mints so a retried
   * emission carries the same identity; Linear generates one otherwise.
   */
  createAgentActivity(input: {
    linearOrganizationId: string;
    agentSessionId: string;
    id?: string;
    content: LinearActivityContent;
    ephemeral?: boolean;
    signal?: LinearActivitySignal;
    signalMetadata?: LinearJsonValue;
  }): Promise<{ id: string }>;
  /**
   * Updates the session's plan, external links, or title. External links are only ever added or
   * removed by name, never replaced wholesale, so links other tools attached survive.
   */
  updateAgentSession(input: {
    linearOrganizationId: string;
    agentSessionId: string;
    plan?: readonly LinearPlanStep[];
    addedExternalUrls?: readonly { label: string; url: string }[];
    removedExternalUrls?: readonly string[];
    summary?: string;
  }): Promise<void>;
  readAgentSession(input: {
    linearOrganizationId: string;
    agentSessionId: string;
  }): Promise<LinearAgentSession | undefined>;
  /** The bounded, chronological activities strictly before `beforeCreatedAt`. */
  readAgentSessionActivities(input: {
    linearOrganizationId: string;
    agentSessionId: string;
    beforeCreatedAt: string;
  }): Promise<LinearAgentSessionActivityHistory>;
  /** A team's workflow states in display order; callers pick by `type` (for example `started`). */
  readTeamStates(input: {
    linearOrganizationId: string;
    teamId: string;
  }): Promise<LinearTeamState[]>;
  updateIssue(input: {
    linearOrganizationId: string;
    issueId: string;
    stateId?: string;
    delegateId?: string;
  }): Promise<void>;
  linkGitHubPullRequest(input: {
    linearOrganizationId: string;
    issueId: string;
    url: string;
    title?: string;
  }): Promise<void>;
}

export function hasRequiredLinearScopes(scopes: readonly string[]): boolean {
  const granted = new Set(scopes);
  return LINEAR_REQUIRED_SCOPES.every((scope) => granted.has(scope));
}

export function linearConnectionRequiresReauthorization(
  connection: Pick<LinearConnectionRecord, "scopes" | "refreshToken" | "accessTokenExpiresAt">,
  now = new Date(),
): boolean {
  return (
    !hasRequiredLinearScopes(connection.scopes) ||
    (connection.refreshToken === null && !hasUsableLinearAccessToken(connection, now))
  );
}

function hasUsableLinearAccessToken(
  connection: Pick<LinearConnectionRecord, "accessTokenExpiresAt">,
  now: Date,
): boolean {
  const expiresAt = connection.accessTokenExpiresAt;
  return (
    expiresAt === null || expiresAt.getTime() > now.getTime() + LINEAR_ACCESS_TOKEN_REFRESH_SKEW_MS
  );
}

export function createLinearConnectionClient(options: {
  clientId: string;
  clientSecret: string;
  publicBaseUrl: string;
  fetch?: typeof fetch;
  now?: () => Date;
}): LinearConnectionClient {
  const request = options.fetch ?? fetch;
  const redirectUri = new URL(
    "/api/integrations/linear/callback",
    options.publicBaseUrl,
  ).toString();
  const now = options.now ?? (() => new Date());

  return {
    authorizationUrl(state) {
      const parameters = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: LINEAR_REQUIRED_SCOPES.join(","),
        state,
        // Keep workflow results visibly attributable to the installed Paseo application instead
        // of impersonating the administrator who completed the connection.
        actor: "app",
      });
      return `https://linear.app/oauth/authorize?${parameters.toString()}`;
    },
    async exchangeCode(code) {
      const token = await exchangeToken(
        request,
        options,
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        },
        now,
      );
      const viewer = await readViewer(request, token.accessToken);
      return {
        linearOrganizationId: viewer.organization.id,
        linearOrganizationName: viewer.organization.name,
        appUserId: viewer.id,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken ?? null,
        accessTokenExpiresAt: token.accessTokenExpiresAt ?? null,
        scopes: token.scopes ?? [...LINEAR_REQUIRED_SCOPES],
      };
    },
    async refresh(refreshToken) {
      const token = await exchangeToken(
        request,
        options,
        {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        },
        now,
      );
      return {
        accessToken: token.accessToken,
        ...(token.refreshToken === undefined ? {} : { refreshToken: token.refreshToken }),
        accessTokenExpiresAt: token.accessTokenExpiresAt ?? null,
        ...(token.scopes === undefined ? {} : { scopes: token.scopes }),
      };
    },
    async revoke(accessToken, refreshToken) {
      await revokeToken(request, options, accessToken, "access_token");
      if (refreshToken !== undefined && refreshToken !== null) {
        await revokeToken(request, options, refreshToken, "refresh_token");
      }
    },
  };
}

async function revokeToken(
  request: typeof fetch,
  options: Pick<Parameters<typeof createLinearConnectionClient>[0], "clientId" | "clientSecret">,
  token: string,
  tokenTypeHint: "access_token" | "refresh_token",
): Promise<void> {
  const response = await request("https://api.linear.app/oauth/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      token,
      token_type_hint: tokenTypeHint,
    }),
  });
  if (!response.ok) throw new Error(`Linear revoke HTTP ${response.status}`);
}

/**
 * The API client always finds credentials through the external Linear organization ID. That ID is
 * part of signed webhook evidence and output context, while Hub organization IDs remain internal.
 */
export function createLinearApiClient(options: {
  connectionForLinearOrganization(
    linearOrganizationId: string,
  ): Promise<LinearConnectionRecord | undefined>;
  withLinearConnectionRefresh: Database["withLinearConnectionRefresh"];
  connectionClient: Pick<LinearConnectionClient, "refresh">;
  fetch?: typeof fetch;
  now?: () => Date;
}): LinearApiClient {
  const request = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  // Avoid duplicate local work, while the database transaction remains the cross-process source of
  // truth for refresh serialization and rebind safety.
  const refreshes = new Map<string, Promise<string>>();

  const hasUsableAccessToken = (connection: LinearConnectionRecord): boolean =>
    hasUsableLinearAccessToken(connection, now());

  const accessTokenFor = async (linearOrganizationId: string): Promise<string> => {
    const connection = await options.connectionForLinearOrganization(linearOrganizationId);
    if (connection === undefined) throw new Error("Linear connection unavailable");
    if (hasUsableAccessToken(connection)) return connection.accessToken;
    if (connection.refreshToken === null)
      throw new Error("Linear connection requires reauthorization");
    return refreshAccessToken(linearOrganizationId, connection);
  };

  const refreshAccessToken = async (
    linearOrganizationId: string,
    connection: LinearConnectionRecord,
  ): Promise<string> => {
    const existing = refreshes.get(connection.id);
    if (existing !== undefined) return existing;
    const pending = options.withLinearConnectionRefresh(
      linearOrganizationId,
      async (current, updateTokens) => {
        if (current === undefined) throw new Error("Linear connection unavailable");
        if (hasUsableAccessToken(current)) return current.accessToken;
        if (current.refreshToken === null)
          throw new Error("Linear connection requires reauthorization");
        const refreshed = await options.connectionClient.refresh(current.refreshToken);
        await updateTokens(refreshed);
        return refreshed.accessToken;
      },
    );
    refreshes.set(connection.id, pending);
    try {
      return await pending;
    } finally {
      if (refreshes.get(connection.id) === pending) refreshes.delete(connection.id);
    }
  };

  return {
    async readIssue(input) {
      const result = IssueResponseSchema.parse(
        await graphql(request, await accessTokenFor(input.linearOrganizationId), {
          query: `query PaseoIssue($id: String!) {
            issue(id: $id) {
              id identifier title description url branchName
              team { id key name }
              project { id }
              state { id name type }
              assignee { id }
              delegate { id }
              labels { nodes { id } }
            }
          }`,
          variables: { id: input.issueId },
        }),
      );
      const issue = result.data.issue;
      return issue === null
        ? undefined
        : {
            id: issue.id,
            ...(issue.identifier === undefined ? {} : { identifier: issue.identifier }),
            title: issue.title,
            description: issue.description ?? null,
            ...(issue.url === undefined ? {} : { url: issue.url }),
            ...(issue.branchName === undefined ? {} : { branchName: issue.branchName }),
            ...(issue.team === undefined || issue.team === null
              ? {}
              : { teamId: issue.team.id, team: issue.team }),
            projectId: issue.project?.id ?? null,
            stateId: issue.state?.id ?? null,
            ...(issue.state === undefined ? {} : { state: issue.state }),
            assigneeId: issue.assignee?.id ?? null,
            ...(issue.delegate === undefined ? {} : { delegateId: issue.delegate?.id ?? null }),
            labelIds: issue.labels.nodes.map(({ id }) => id),
          };
    },
    async readIssueComments(input) {
      const result = IssueCommentHistoryResponseSchema.parse(
        await graphql(request, await accessTokenFor(input.linearOrganizationId), {
          query: `query PaseoIssueCommentHistory($issueId: String!, $before: DateTime!) {
            comments(
              last: ${LINEAR_ISSUE_COMMENT_CONTEXT_LIMIT}
              orderBy: createdAt
              filter: {
                issue: { id: { eq: $issueId } }
                createdAt: { lt: $before }
              }
            ) {
              nodes { id body createdAt user { id name } }
              pageInfo { hasPreviousPage }
            }
          }`,
          variables: { issueId: input.issueId, before: input.beforeCreatedAt },
        }),
      );
      const comments = result.data.comments.nodes
        .map((comment) => ({
          id: comment.id,
          body: comment.body,
          createdAt: comment.createdAt,
          author:
            comment.user === undefined || comment.user === null
              ? null
              : {
                  id: comment.user.id,
                  ...(comment.user.name === undefined || comment.user.name === null
                    ? {}
                    : { name: comment.user.name }),
                },
        }))
        .sort(compareLinearCommentOrder);
      return {
        comments,
        complete: !result.data.comments.pageInfo.hasPreviousPage,
      };
    },
    async createComment(input) {
      const result = CommentResponseSchema.parse(
        await graphql(request, await accessTokenFor(input.linearOrganizationId), {
          query: `mutation PaseoComment($issueId: String!, $body: String!) {
            commentCreate(input: { issueId: $issueId, body: $body }) { success }
          }`,
          variables: { issueId: input.issueId, body: input.body },
        }),
      );
      if (!result.data.commentCreate.success) throw new Error("Linear comment was not accepted");
    },
    async createAgentActivity(input) {
      const result = AgentActivityCreateResponseSchema.parse(
        await graphql(request, await accessTokenFor(input.linearOrganizationId), {
          query: `mutation PaseoAgentActivityCreate($input: AgentActivityCreateInput!) {
            agentActivityCreate(input: $input) { success agentActivity { id } }
          }`,
          variables: {
            input: {
              agentSessionId: input.agentSessionId,
              ...(input.id === undefined ? {} : { id: input.id }),
              content: input.content,
              ...(input.ephemeral === undefined ? {} : { ephemeral: input.ephemeral }),
              ...(input.signal === undefined ? {} : { signal: input.signal }),
              ...(input.signalMetadata === undefined
                ? {}
                : { signalMetadata: input.signalMetadata }),
            },
          },
        }),
      );
      if (!result.data.agentActivityCreate.success) {
        throw new Error("Linear agent activity was not accepted");
      }
      return { id: result.data.agentActivityCreate.agentActivity.id };
    },
    async updateAgentSession(input) {
      const result = AgentSessionUpdateResponseSchema.parse(
        await graphql(request, await accessTokenFor(input.linearOrganizationId), {
          query: `mutation PaseoAgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
            agentSessionUpdate(id: $id, input: $input) { success }
          }`,
          variables: {
            id: input.agentSessionId,
            // Never `externalUrls` or `externalLink`: those replace every link on the session.
            input: {
              ...(input.plan === undefined ? {} : { plan: input.plan }),
              ...(input.addedExternalUrls === undefined
                ? {}
                : { addedExternalUrls: input.addedExternalUrls }),
              ...(input.removedExternalUrls === undefined
                ? {}
                : { removedExternalUrls: input.removedExternalUrls }),
              ...(input.summary === undefined ? {} : { summary: input.summary }),
            },
          },
        }),
      );
      if (!result.data.agentSessionUpdate.success) {
        throw new Error("Linear agent session update was not accepted");
      }
    },
    async readAgentSession(input) {
      const result = AgentSessionResponseSchema.parse(
        await graphql(request, await accessTokenFor(input.linearOrganizationId), {
          query: `query PaseoAgentSession($id: String!) {
            agentSession(id: $id) { id status summary url issue { id identifier } }
          }`,
          variables: { id: input.agentSessionId },
        }),
      );
      const session = result.data.agentSession;
      return session === null
        ? undefined
        : {
            id: session.id,
            status: session.status,
            summary: session.summary ?? null,
            url: session.url ?? null,
            issue: session.issue ?? null,
          };
    },
    async readAgentSessionActivities(input) {
      const result = AgentSessionActivitiesResponseSchema.parse(
        await graphql(request, await accessTokenFor(input.linearOrganizationId), {
          query: `query PaseoAgentSessionActivities($id: String!, $before: DateTime!) {
            agentSession(id: $id) {
              activities(
                last: ${LINEAR_ISSUE_COMMENT_CONTEXT_LIMIT}
                orderBy: createdAt
                filter: { createdAt: { lt: $before } }
              ) {
                nodes {
                  id createdAt signal user { id name }
                  content {
                    __typename
                    ... on AgentActivityPromptContent { body }
                    ... on AgentActivityResponseContent { body }
                    ... on AgentActivityErrorContent { body }
                    ... on AgentActivityElicitationContent { body }
                  }
                }
                pageInfo { hasPreviousPage }
              }
            }
          }`,
          variables: { id: input.agentSessionId, before: input.beforeCreatedAt },
        }),
      );
      const session = result.data.agentSession;
      if (session === null) throw new Error("Linear agent session unavailable");
      const activities = session.activities.nodes
        .map(normalizeAgentSessionActivity)
        .filter((activity) => activity !== undefined)
        .sort(compareLinearCommentOrder);
      return { activities, complete: !session.activities.pageInfo.hasPreviousPage };
    },
    async readTeamStates(input) {
      const result = TeamStatesResponseSchema.parse(
        await graphql(request, await accessTokenFor(input.linearOrganizationId), {
          query: `query PaseoTeamStates($id: String!) {
            team(id: $id) { states { nodes { id name type position } } }
          }`,
          variables: { id: input.teamId },
        }),
      );
      const team = result.data.team;
      if (team === null) throw new Error("Linear team unavailable");
      return [...team.states.nodes].sort((left, right) => left.position - right.position);
    },
    async updateIssue(input) {
      const result = IssueUpdateResponseSchema.parse(
        await graphql(request, await accessTokenFor(input.linearOrganizationId), {
          query: `mutation PaseoIssueUpdate($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) { success }
          }`,
          variables: {
            id: input.issueId,
            input: {
              ...(input.stateId === undefined ? {} : { stateId: input.stateId }),
              ...(input.delegateId === undefined ? {} : { delegateId: input.delegateId }),
            },
          },
        }),
      );
      if (!result.data.issueUpdate.success) throw new Error("Linear issue update was not accepted");
    },
    async linkGitHubPullRequest(input) {
      const result = AttachmentLinkResponseSchema.parse(
        await graphql(request, await accessTokenFor(input.linearOrganizationId), {
          query: `mutation PaseoAttachmentLinkGitHubPR($issueId: String!, $url: String!, $title: String) {
            attachmentLinkGitHubPR(issueId: $issueId, url: $url, title: $title) { success }
          }`,
          variables: {
            issueId: input.issueId,
            url: input.url,
            ...(input.title === undefined ? {} : { title: input.title }),
          },
        }),
      );
      if (!result.data.attachmentLinkGitHubPR.success) {
        throw new Error("Linear pull request link was not accepted");
      }
    },
  };
}

function normalizeAgentSessionActivity(
  node: z.infer<typeof AgentSessionActivityNodeSchema>,
): LinearAgentSessionActivity | undefined {
  const kind = ACTIVITY_CONTENT_TYPENAMES.get(node.content.__typename);
  if (kind === undefined) return undefined;
  const content: LinearAgentSessionActivity["content"] =
    kind === "thought" || kind === "action" ? { kind } : { kind, body: node.content.body ?? "" };
  return {
    id: node.id,
    createdAt: node.createdAt,
    signal: node.signal ?? null,
    user:
      node.user === undefined || node.user === null
        ? null
        : {
            id: node.user.id,
            ...(node.user.name === undefined || node.user.name === null
              ? {}
              : { name: node.user.name }),
          },
    content,
  };
}

function compareLinearCommentOrder(
  left: Pick<LinearIssueComment, "createdAt" | "id">,
  right: Pick<LinearIssueComment, "createdAt" | "id">,
): number {
  const byCreatedAt = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return byCreatedAt === 0 ? left.id.localeCompare(right.id) : byCreatedAt;
}

async function exchangeToken(
  request: typeof fetch,
  options: Pick<Parameters<typeof createLinearConnectionClient>[0], "clientId" | "clientSecret">,
  values: Record<string, string>,
  now: () => Date,
): Promise<{
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt?: Date;
  scopes?: string[];
}> {
  const response = await request("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      ...values,
    }),
  });
  if (!response.ok) throw new Error(`Linear OAuth HTTP ${response.status}`);
  const token = LinearTokenResponseSchema.parse(await response.json());
  return {
    accessToken: token.access_token,
    ...(token.refresh_token === undefined ? {} : { refreshToken: token.refresh_token }),
    ...(token.expires_in === undefined
      ? {}
      : { accessTokenExpiresAt: new Date(now().getTime() + token.expires_in * 1_000) }),
    ...(token.scope === undefined ? {} : { scopes: parseLinearScopes(token.scope) }),
  };
}

async function readViewer(request: typeof fetch, accessToken: string) {
  const result = ViewerResponseSchema.parse(
    await graphql(request, accessToken, {
      query: `query PaseoViewer { viewer { id organization { id name } } }`,
      variables: {},
    }),
  );
  return result.data.viewer;
}

async function graphql(
  request: typeof fetch,
  accessToken: string,
  payload: { query: string; variables: Record<string, unknown> },
): Promise<unknown> {
  const response = await request("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new LinearApiError(`Linear GraphQL HTTP ${response.status}`, {
      status: response.status,
    });
  }
  const result: unknown = await response.json();
  const errors = GraphqlErrorSchema.safeParse(result);
  if (errors.success && errors.data.errors !== undefined) {
    const [first] = errors.data.errors;
    throw new LinearApiError(`Linear GraphQL ${first!.message}`, {
      status: response.status,
      ...(first!.extensions?.code === undefined ? {} : { code: first!.extensions.code }),
    });
  }
  return result;
}

function parseLinearScopes(scope: string | readonly string[] | undefined): string[] {
  const values = typeof scope === "string" ? [scope] : (scope ?? []);
  return [
    ...new Set(
      values
        .flatMap((value) => value.split(/[\s,]+/u))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].sort();
}
