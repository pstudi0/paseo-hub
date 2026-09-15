import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type {
  Database,
  LinearConnectionRecord,
  LinearConnectionTokenUpdate,
  UpdateLinearConnectionTokensInput,
} from "../../db/types.js";
import { createMemoryDatabase } from "../../db/memory.js";
import {
  createLinearApiClient,
  createLinearConnectionClient,
  hasRequiredLinearScopes,
  LINEAR_REQUIRED_SCOPES,
  LinearApiError,
  type LinearApiClient,
} from "./client.js";

const AGENT_SCOPE_PARAMETER = "read,write,comments:create,app:assignable,app:mentionable";
const GRANTED_SCOPES = ["app:assignable", "app:mentionable", "comments:create", "read", "write"];

describe("Linear connection client", () => {
  it("uses an OAuth callback URL and records the installed workspace identity", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const client = createLinearConnectionClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      publicBaseUrl: "https://hub.test/base",
      now: () => new Date(1_700_000_000_000),
      fetch: async (url, init) => {
        const requestUrl = readableUrl(url);
        requests.push({ url: requestUrl, body: readableBody(init?.body) });
        if (requestUrl.endsWith("/oauth/token")) {
          return json({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 3600,
            scope: AGENT_SCOPE_PARAMETER,
          });
        }
        return json({
          data: { viewer: { id: "app-user", organization: { id: "linear-org", name: "Acme" } } },
        });
      },
    });

    const authorization = new URL(client.authorizationUrl("state-value"));
    assert.equal(authorization.origin, "https://linear.app");
    assert.equal(
      authorization.searchParams.get("redirect_uri"),
      "https://hub.test/api/integrations/linear/callback",
    );
    assert.equal(authorization.searchParams.get("scope"), AGENT_SCOPE_PARAMETER);
    assert.equal(authorization.searchParams.get("actor"), "app");
    assert.equal(authorization.searchParams.get("state"), "state-value");

    assert.deepEqual(await client.exchangeCode("code-value"), {
      linearOrganizationId: "linear-org",
      linearOrganizationName: "Acme",
      appUserId: "app-user",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: new Date(1_700_003_600_000),
      scopes: GRANTED_SCOPES,
    });
    assert.match(requests[0]?.body ?? "", /code=code-value/u);
  });

  it("accepts the granted scopes as an array from applications created before December 2023", async () => {
    const client = createLinearConnectionClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      publicBaseUrl: "https://hub.test",
      fetch: async (url) => {
        if (readableUrl(url).endsWith("/oauth/token")) {
          return json({
            access_token: "access-token",
            scope: ["read", "write", "comments:create", "app:assignable", "app:mentionable"],
          });
        }
        return json({
          data: { viewer: { id: "app-user", organization: { id: "linear-org", name: "Acme" } } },
        });
      },
    });

    const installation = await client.exchangeCode("code-value");

    assert.deepEqual(installation.scopes, GRANTED_SCOPES);
  });

  it("revokes the refresh token alongside the access token", async () => {
    const bodies: string[] = [];
    const client = createLinearConnectionClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      publicBaseUrl: "https://hub.test",
      fetch: async (url, init) => {
        assert.equal(readableUrl(url), "https://api.linear.app/oauth/revoke");
        bodies.push(readableBody(init?.body));
        return new Response(null, { status: 200 });
      },
    });

    await client.revoke("access-token", "refresh-token");
    await client.revoke("only-access-token");

    assert.deepEqual(bodies, [
      "client_id=client-id&client_secret=client-secret&token=access-token&token_type_hint=access_token",
      "client_id=client-id&client_secret=client-secret&token=refresh-token&token_type_hint=refresh_token",
      "client_id=client-id&client_secret=client-secret&token=only-access-token&token_type_hint=access_token",
    ]);
  });

  it("keeps requested scopes when Linear omits them during authorization", async () => {
    const client = createLinearConnectionClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      publicBaseUrl: "https://hub.test",
      fetch: async (url) => {
        if (readableUrl(url).endsWith("/oauth/token")) {
          return json({ access_token: "access-token", refresh_token: "refresh-token" });
        }
        return json({
          data: { viewer: { id: "app-user", organization: { id: "linear-org", name: "Acme" } } },
        });
      },
    });

    const installation = await client.exchangeCode("code-value");

    assert.deepEqual(installation.scopes, [...LINEAR_REQUIRED_SCOPES]);
  });

  it("reads a bounded, chronological history before the triggering comment", async () => {
    const requests: Array<{ authorization: string | null; body: string }> = [];
    const connection: LinearConnectionRecord = {
      id: "connection-1",
      organizationId: "hub-org",
      slug: "acme-linear",
      providerApplicationId: "linear-app",
      linearOrganizationId: "linear-org",
      linearOrganizationName: "Acme",
      appUserId: "app-user",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: null,
      scopes: ["comments:create", "read"],
    };
    const api = createLinearApiClient({
      connectionForLinearOrganization: async () => connection,
      withLinearConnectionRefresh: withinLinearRefresh(connection, async () => {}),
      connectionClient: { refresh: async () => ({ accessToken: "unused" }) },
      fetch: async (_url, init) => {
        requests.push({
          authorization: new Headers(init?.headers).get("authorization"),
          body: readableBody(init?.body),
        });
        return json({
          data: {
            comments: {
              nodes: [
                {
                  id: "comment-2",
                  body: "second",
                  createdAt: "2023-11-14T22:13:19.002Z",
                  user: { id: "user-2", name: "Paseo" },
                },
                {
                  id: "comment-1",
                  body: "first",
                  createdAt: "2023-11-14T22:13:19.001Z",
                  user: null,
                },
              ],
              pageInfo: { hasPreviousPage: true },
            },
          },
        });
      },
    });

    const history = await api.readIssueComments({
      linearOrganizationId: "linear-org",
      issueId: "issue-1",
      beforeCreatedAt: "2023-11-14T22:13:19.003Z",
    });

    assert.deepEqual(history, {
      complete: false,
      comments: [
        {
          id: "comment-1",
          body: "first",
          createdAt: "2023-11-14T22:13:19.001Z",
          author: null,
        },
        {
          id: "comment-2",
          body: "second",
          createdAt: "2023-11-14T22:13:19.002Z",
          author: { id: "user-2", name: "Paseo" },
        },
      ],
    });
    assert.equal(requests[0]?.authorization, "Bearer access-token");
    const request = graphqlRequest(requests[0]?.body ?? "{}");
    // `createdAt.lt` is a DateTimeOrDuration slot: Linear rejects a DateTime! variable there.
    assert.match(
      request.query,
      /query PaseoIssueCommentHistory\(\$issueId: String!, \$before: DateTimeOrDuration!\)/u,
    );
    assert.match(request.query, /last: 49/u);
    assert.match(request.query, /orderBy: createdAt/u);
    assert.match(request.query, /createdAt: \{ lt: \$before \}/u);
    assert.deepEqual(request.variables, {
      issueId: "issue-1",
      before: "2023-11-14T22:13:19.003Z",
    });
  });

  it("refreshes an expired token before calling the Linear GraphQL API", async () => {
    const updates: unknown[] = [];
    const requests: Array<{ url: string; authorization: string | null; body: string }> = [];
    const connection: LinearConnectionRecord = {
      id: "connection-1",
      organizationId: "hub-org",
      slug: "acme-linear",
      providerApplicationId: "linear-app",
      linearOrganizationId: "linear-org",
      linearOrganizationName: "Acme",
      appUserId: "app-user",
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: new Date(1_700_000_000_000),
      scopes: ["comments:create", "read"],
    };
    const updateTokens = async (update: UpdateLinearConnectionTokensInput) => {
      updates.push(update);
    };
    const api = createLinearApiClient({
      connectionForLinearOrganization: async () => connection,
      withLinearConnectionRefresh: withinLinearRefresh(connection, updateTokens),
      connectionClient: {
        refresh: async () => ({
          accessToken: "fresh-token",
          refreshToken: "next-refresh-token",
          accessTokenExpiresAt: new Date(1_700_003_600_000),
          scopes: ["comments:create", "read"],
        }),
      },
      now: () => new Date(1_700_000_010_000),
      fetch: async (url, init) => {
        requests.push({
          url: readableUrl(url),
          authorization: new Headers(init?.headers).get("authorization"),
          body: readableBody(init?.body),
        });
        return json({ data: { commentCreate: { success: true } } });
      },
    });

    await api.createComment({
      linearOrganizationId: "linear-org",
      issueId: "issue-1",
      body: "Done",
    });
    assert.deepEqual(updates, [
      {
        connectionId: "connection-1",
        accessToken: "fresh-token",
        refreshToken: "next-refresh-token",
        accessTokenExpiresAt: new Date(1_700_003_600_000),
        scopes: ["comments:create", "read"],
      },
    ]);
    assert.equal(requests[0]?.authorization, "Bearer fresh-token");
    assert.match(requests[0]?.body ?? "", /commentCreate/u);
  });

  it("clears a stale expiry when Linear omits it from a refresh response", async () => {
    const updates: unknown[] = [];
    let tokenRequests = 0;
    const connection: LinearConnectionRecord = {
      id: "connection-1",
      organizationId: "hub-org",
      slug: "acme-linear",
      providerApplicationId: "linear-app",
      linearOrganizationId: "linear-org",
      linearOrganizationName: "Acme",
      appUserId: "app-user",
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: new Date(1_700_000_000_000),
      scopes: ["comments:create", "read"],
    };
    const request: typeof fetch = async (url) => {
      if (readableUrl(url).endsWith("/oauth/token")) {
        tokenRequests += 1;
        return json({ access_token: "fresh-token" });
      }
      return json({ data: { commentCreate: { success: true } } });
    };
    const updateTokens = async (update: UpdateLinearConnectionTokensInput) => {
      updates.push(update);
      connection.accessToken = update.accessToken;
      if (update.refreshToken !== undefined) connection.refreshToken = update.refreshToken;
      if (update.accessTokenExpiresAt !== undefined)
        connection.accessTokenExpiresAt = update.accessTokenExpiresAt;
      if (update.scopes !== undefined) connection.scopes = update.scopes;
    };
    const api = createLinearApiClient({
      connectionForLinearOrganization: async () => connection,
      withLinearConnectionRefresh: withinLinearRefresh(connection, updateTokens),
      connectionClient: createLinearConnectionClient({
        clientId: "client-id",
        clientSecret: "client-secret",
        publicBaseUrl: "https://hub.test",
        fetch: request,
        now: () => new Date(1_700_000_010_000),
      }),
      fetch: request,
      now: () => new Date(1_700_000_010_000),
    });

    await api.createComment({
      linearOrganizationId: "linear-org",
      issueId: "issue-1",
      body: "Done",
    });
    await api.createComment({
      linearOrganizationId: "linear-org",
      issueId: "issue-1",
      body: "Still done",
    });

    assert.deepEqual(updates, [
      {
        connectionId: "connection-1",
        accessToken: "fresh-token",
        accessTokenExpiresAt: null,
      },
    ]);
    assert.equal(tokenRequests, 1);
  });

  it("coalesces concurrent refreshes for one Linear connection", async () => {
    const connection: LinearConnectionRecord = {
      id: "connection-1",
      organizationId: "hub-org",
      slug: "acme-linear",
      providerApplicationId: "linear-app",
      linearOrganizationId: "linear-org",
      linearOrganizationName: "Acme",
      appUserId: "app-user",
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: new Date(1_700_000_000_000),
      scopes: ["comments:create", "read"],
    };
    const updates: unknown[] = [];
    const requests: string[] = [];
    let connectionReads = 0;
    let releaseConnections!: () => void;
    let markBothConnectionsRead!: () => void;
    let releaseRefresh!: (value: { accessToken: string; refreshToken: string }) => void;
    let markRefreshStarted!: () => void;
    const connectionsReleased = new Promise<void>((resolve) => {
      releaseConnections = resolve;
    });
    const bothConnectionsRead = new Promise<void>((resolve) => {
      markBothConnectionsRead = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const refreshed = new Promise<{ accessToken: string; refreshToken: string }>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshCalls = 0;
    const updateTokens = async (update: UpdateLinearConnectionTokensInput) => {
      updates.push(update);
    };
    const api = createLinearApiClient({
      connectionForLinearOrganization: async () => {
        connectionReads += 1;
        if (connectionReads === 2) markBothConnectionsRead();
        await connectionsReleased;
        return connection;
      },
      withLinearConnectionRefresh: withinLinearRefresh(connection, updateTokens),
      connectionClient: {
        refresh: async () => {
          refreshCalls += 1;
          markRefreshStarted();
          return refreshed;
        },
      },
      now: () => new Date(1_700_000_010_000),
      fetch: async (_url, init) => {
        requests.push(new Headers(init?.headers).get("authorization") ?? "");
        return json({ data: { commentCreate: { success: true } } });
      },
    });

    const operations = [
      api.createComment({ linearOrganizationId: "linear-org", issueId: "issue-1", body: "One" }),
      api.createComment({ linearOrganizationId: "linear-org", issueId: "issue-2", body: "Two" }),
    ];
    await bothConnectionsRead;
    releaseConnections();
    await refreshStarted;

    assert.equal(refreshCalls, 1);
    releaseRefresh({ accessToken: "fresh-token", refreshToken: "next-refresh-token" });
    await Promise.all(operations);

    assert.deepEqual(updates, [
      {
        connectionId: "connection-1",
        accessToken: "fresh-token",
        refreshToken: "next-refresh-token",
      },
    ]);
    assert.deepEqual(requests, ["Bearer fresh-token", "Bearer fresh-token"]);
  });

  it("serializes rotating-token refreshes across Linear API clients", async () => {
    const locks = createMemoryDatabase();
    const lockKeys: string[] = [];
    const connection: LinearConnectionRecord = {
      id: "connection-1",
      organizationId: "hub-org",
      slug: "acme-linear",
      providerApplicationId: "linear-app",
      linearOrganizationId: "linear-org",
      linearOrganizationName: "Acme",
      appUserId: "app-user",
      accessToken: "expired-token",
      refreshToken: "rotating-refresh-token",
      accessTokenExpiresAt: new Date(1_700_000_000_000),
      scopes: ["comments:create", "read"],
    };
    const updates: unknown[] = [];
    const requests: string[] = [];
    let connectionReads = 0;
    let refreshCalls = 0;
    let releaseRefresh!: () => void;
    let markRefreshStarted!: () => void;
    let markSecondInitialRead!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const secondInitialRead = new Promise<void>((resolve) => {
      markSecondInitialRead = resolve;
    });
    const refreshReleased = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const connectionForLinearOrganization = async () => {
      connectionReads += 1;
      if (connectionReads === 2) markSecondInitialRead();
      return connection;
    };
    const updateTokens = async (update: {
      connectionId: string;
      accessToken: string;
      refreshToken?: string | null;
      accessTokenExpiresAt?: Date | null;
      scopes?: string[];
    }) => {
      updates.push(update);
      connection.accessToken = update.accessToken;
      if (update.refreshToken !== undefined) connection.refreshToken = update.refreshToken;
      if (update.accessTokenExpiresAt !== undefined)
        connection.accessTokenExpiresAt = update.accessTokenExpiresAt;
      if (update.scopes !== undefined) connection.scopes = update.scopes;
    };
    const withLinearConnectionRefresh: Database["withLinearConnectionRefresh"] = async (
      linearOrganizationId,
      operation,
    ) => {
      const key = JSON.stringify(["paseo-connection", "linear", "external", linearOrganizationId]);
      lockKeys.push(key);
      const updateWithinRefresh = (input: LinearConnectionTokenUpdate) =>
        updateTokens({ connectionId: connection.id, ...input });
      return locks.withAdvisoryLock(key, () => operation(connection, updateWithinRefresh));
    };
    const sharedOptions = {
      connectionForLinearOrganization,
      withLinearConnectionRefresh,
      connectionClient: {
        refresh: async () => {
          refreshCalls += 1;
          markRefreshStarted();
          await refreshReleased;
          return {
            accessToken: "fresh-token",
            refreshToken: "next-rotating-refresh-token",
            accessTokenExpiresAt: new Date(1_700_003_600_000),
          };
        },
      },
      now: () => new Date(1_700_000_010_000),
      fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Headers(init?.headers).get("authorization") ?? "");
        return json({ data: { commentCreate: { success: true } } });
      },
    };
    const firstProcess = createLinearApiClient(sharedOptions);
    const secondProcess = createLinearApiClient(sharedOptions);

    const first = firstProcess.createComment({
      linearOrganizationId: "linear-org",
      issueId: "issue-1",
      body: "One",
    });
    await refreshStarted;
    const second = secondProcess.createComment({
      linearOrganizationId: "linear-org",
      issueId: "issue-2",
      body: "Two",
    });
    await secondInitialRead;
    releaseRefresh();
    await Promise.all([first, second]);

    assert.equal(refreshCalls, 1);
    assert.equal(connectionReads, 2);
    assert.deepEqual(lockKeys, [
      '["paseo-connection","linear","external","linear-org"]',
      '["paseo-connection","linear","external","linear-org"]',
    ]);
    assert.deepEqual(updates, [
      {
        connectionId: "connection-1",
        accessToken: "fresh-token",
        refreshToken: "next-rotating-refresh-token",
        accessTokenExpiresAt: new Date(1_700_003_600_000),
      },
    ]);
    assert.deepEqual(requests, ["Bearer fresh-token", "Bearer fresh-token"]);
  });

  it("requires every agent scope, so pre-agent connections must be authorized again", () => {
    assert.equal(hasRequiredLinearScopes(GRANTED_SCOPES), true);
    assert.equal(hasRequiredLinearScopes(["read", "comments:create"]), false);
    assert.equal(
      hasRequiredLinearScopes(["read", "write", "comments:create", "app:assignable"]),
      false,
    );
  });
});

describe("Linear API client contracts", () => {
  it("reads an issue with its branch, team, workflow state, and delegate", async () => {
    const { api, requests } = apiClient(() =>
      json({
        data: {
          issue: {
            id: "issue-1",
            identifier: "ENG-42",
            title: "Fix login",
            description: null,
            url: "https://linear.app/acme/issue/ENG-42",
            branchName: "acme/eng-42-fix-login",
            team: { id: "team-1", key: "ENG", name: "Engineering" },
            project: null,
            state: { id: "state-1", name: "Todo", type: "unstarted" },
            assignee: { id: "user-1" },
            delegate: null,
            labels: { nodes: [{ id: "label-1" }] },
          },
        },
      }),
    );

    const issue = await api.readIssue({ linearOrganizationId: "linear-org", issueId: "issue-1" });

    assert.deepEqual(issue, {
      id: "issue-1",
      identifier: "ENG-42",
      title: "Fix login",
      description: null,
      url: "https://linear.app/acme/issue/ENG-42",
      branchName: "acme/eng-42-fix-login",
      teamId: "team-1",
      team: { id: "team-1", key: "ENG", name: "Engineering" },
      projectId: null,
      stateId: "state-1",
      state: { id: "state-1", name: "Todo", type: "unstarted" },
      assigneeId: "user-1",
      delegateId: null,
      labelIds: ["label-1"],
    });
    const request = graphqlRequest(requests[0]!.body);
    for (const field of [
      "branchName",
      "team { id key name }",
      "state { id name type }",
      "delegate { id }",
    ]) {
      assert.ok(request.query.includes(field), `query lacks ${field}`);
    }
    assert.deepEqual(request.variables, { id: "issue-1" });
  });

  it("creates an agent activity with the caller's id, signal, and metadata", async () => {
    const { api, requests } = apiClient(() =>
      json({
        data: {
          agentActivityCreate: { success: true, agentActivity: { id: "activity-1" } },
        },
      }),
    );

    const created = await api.createAgentActivity({
      linearOrganizationId: "linear-org",
      agentSessionId: "session-1",
      id: "5f0c7c7e-2c2a-4c6d-9a53-6f2a9d6b1c01",
      content: { type: "elicitation", body: "Which branch?" },
      ephemeral: true,
      signal: "select",
      signalMetadata: { options: [{ id: "main", label: "main" }] },
    });

    assert.deepEqual(created, { id: "activity-1" });
    const request = graphqlRequest(requests[0]!.body);
    assert.match(
      request.query,
      /mutation PaseoAgentActivityCreate\(\$input: AgentActivityCreateInput!\)/u,
    );
    assert.match(
      request.query,
      /agentActivityCreate\(input: \$input\) \{ success agentActivity \{ id \} \}/u,
    );
    assert.deepEqual(request.variables, {
      input: {
        agentSessionId: "session-1",
        id: "5f0c7c7e-2c2a-4c6d-9a53-6f2a9d6b1c01",
        content: { type: "elicitation", body: "Which branch?" },
        ephemeral: true,
        signal: "select",
        signalMetadata: { options: [{ id: "main", label: "main" }] },
      },
    });
  });

  it("omits every optional activity field it was not given", async () => {
    const { api, requests } = apiClient(() =>
      json({
        data: {
          agentActivityCreate: { success: true, agentActivity: { id: "activity-2" } },
        },
      }),
    );

    await api.createAgentActivity({
      linearOrganizationId: "linear-org",
      agentSessionId: "session-1",
      content: { type: "action", action: "Read", parameter: "src/app.ts", result: "120 lines" },
    });

    assert.deepEqual(graphqlRequest(requests[0]!.body).variables, {
      input: {
        agentSessionId: "session-1",
        content: { type: "action", action: "Read", parameter: "src/app.ts", result: "120 lines" },
      },
    });
  });

  it("rejects an activity Linear did not accept", async () => {
    const { api } = apiClient(() =>
      json({
        data: {
          agentActivityCreate: { success: false, agentActivity: { id: "activity-3" } },
        },
      }),
    );

    await assert.rejects(
      api.createAgentActivity({
        linearOrganizationId: "linear-org",
        agentSessionId: "session-1",
        content: { type: "thought", body: "Looking" },
      }),
      /Linear agent activity was not accepted/u,
    );
  });

  it("updates a session's plan, links, and summary without replacing its other links", async () => {
    const { api, requests } = apiClient(() =>
      json({ data: { agentSessionUpdate: { success: true } } }),
    );

    await api.updateAgentSession({
      linearOrganizationId: "linear-org",
      agentSessionId: "session-1",
      plan: [
        { content: "Reproduce", status: "completed" },
        { content: "Fix", status: "inProgress" },
      ],
      addedExternalUrls: [{ label: "Paseo", url: "https://hub.test/o/acme/activity" }],
      removedExternalUrls: ["https://hub.test/old"],
      summary: "Fix login",
    });

    const request = graphqlRequest(requests[0]!.body);
    assert.match(
      request.query,
      /mutation PaseoAgentSessionUpdate\(\$id: String!, \$input: AgentSessionUpdateInput!\)/u,
    );
    assert.match(request.query, /agentSessionUpdate\(id: \$id, input: \$input\) \{ success \}/u);
    assert.deepEqual(request.variables, {
      id: "session-1",
      input: {
        plan: [
          { content: "Reproduce", status: "completed" },
          { content: "Fix", status: "inProgress" },
        ],
        addedExternalUrls: [{ label: "Paseo", url: "https://hub.test/o/acme/activity" }],
        removedExternalUrls: ["https://hub.test/old"],
        summary: "Fix login",
      },
    });
    assert.ok(!request.query.includes("externalUrls:"), "externalUrls replaces every link");
    assert.ok(!request.query.includes("externalLink"), "externalLink replaces every link");
  });

  it("sends only the session fields it was given", async () => {
    const { api, requests } = apiClient(() =>
      json({ data: { agentSessionUpdate: { success: true } } }),
    );

    await api.updateAgentSession({
      linearOrganizationId: "linear-org",
      agentSessionId: "session-1",
      summary: "Only the title",
    });

    assert.deepEqual(graphqlRequest(requests[0]!.body).variables, {
      id: "session-1",
      input: { summary: "Only the title" },
    });
  });

  it("reads a bounded, chronological activity history before a point in time", async () => {
    const { api, requests } = apiClient(() =>
      json({
        data: {
          agentSession: {
            activities: {
              nodes: [
                {
                  id: "activity-3",
                  createdAt: "2023-11-14T22:13:19.003Z",
                  signal: null,
                  user: { id: "app-user", name: "Paseo" },
                  content: { __typename: "AgentActivityResponseContent", body: "Done" },
                },
                {
                  id: "activity-2",
                  createdAt: "2023-11-14T22:13:19.002Z",
                  signal: null,
                  user: { id: "app-user", name: null },
                  content: { __typename: "AgentActivityActionContent" },
                },
                {
                  id: "activity-1",
                  createdAt: "2023-11-14T22:13:19.001Z",
                  signal: "stop",
                  user: { id: "user-1", name: "Ada" },
                  content: { __typename: "AgentActivityPromptContent", body: "Please fix" },
                },
                {
                  id: "activity-0",
                  createdAt: "2023-11-14T22:13:19.000Z",
                  signal: null,
                  user: null,
                  content: { __typename: "AgentActivityFutureContent", body: "unknown" },
                },
              ],
              pageInfo: { hasPreviousPage: true },
            },
          },
        },
      }),
    );

    const history = await api.readAgentSessionActivities({
      linearOrganizationId: "linear-org",
      agentSessionId: "session-1",
      beforeCreatedAt: "2023-11-14T22:13:19.004Z",
    });

    assert.deepEqual(history, {
      complete: false,
      activities: [
        {
          id: "activity-1",
          createdAt: "2023-11-14T22:13:19.001Z",
          signal: "stop",
          user: { id: "user-1", name: "Ada" },
          content: { type: "prompt", body: "Please fix" },
        },
        {
          id: "activity-2",
          createdAt: "2023-11-14T22:13:19.002Z",
          signal: null,
          user: { id: "app-user" },
          content: { type: "action" },
        },
        {
          id: "activity-3",
          createdAt: "2023-11-14T22:13:19.003Z",
          signal: null,
          user: { id: "app-user", name: "Paseo" },
          content: { type: "response", body: "Done" },
        },
      ],
    });
    const request = graphqlRequest(requests[0]!.body);
    assert.match(
      request.query,
      /query PaseoAgentSessionActivities\(\$id: String!, \$before: DateTimeOrDuration!\)/u,
    );
    assert.match(request.query, /last: 49/u);
    assert.match(request.query, /orderBy: createdAt/u);
    assert.match(request.query, /filter: \{ createdAt: \{ lt: \$before \} \}/u);
    for (const content of ["Prompt", "Response", "Error", "Elicitation"]) {
      assert.ok(
        request.query.includes(`... on AgentActivity${content}Content { body }`),
        `query lacks the ${content} fragment`,
      );
    }
    assert.deepEqual(request.variables, { id: "session-1", before: "2023-11-14T22:13:19.004Z" });
  });

  it("reads a team's workflow states in display order", async () => {
    const { api, requests } = apiClient(() =>
      json({
        data: {
          team: {
            states: {
              nodes: [
                { id: "state-done", name: "Done", type: "completed", position: 3 },
                { id: "state-progress", name: "In Progress", type: "started", position: 1 },
                { id: "state-review", name: "In Review", type: "started", position: 2 },
              ],
            },
          },
        },
      }),
    );

    const states = await api.readTeamStates({
      linearOrganizationId: "linear-org",
      teamId: "team-1",
    });

    assert.deepEqual(states, [
      { id: "state-progress", name: "In Progress", type: "started", position: 1 },
      { id: "state-review", name: "In Review", type: "started", position: 2 },
      { id: "state-done", name: "Done", type: "completed", position: 3 },
    ]);
    const request = graphqlRequest(requests[0]!.body);
    assert.match(request.query, /query PaseoTeamStates\(\$id: String!\)/u);
    assert.match(
      request.query,
      /team\(id: \$id\) \{ states \{ nodes \{ id name type position \} \} \}/u,
    );
    assert.deepEqual(request.variables, { id: "team-1" });
  });

  it("updates an issue's state and delegate through issueUpdate", async () => {
    const { api, requests } = apiClient(() => json({ data: { issueUpdate: { success: true } } }));

    await api.updateIssue({
      linearOrganizationId: "linear-org",
      issueId: "issue-1",
      stateId: "state-progress",
      delegateId: "app-user",
    });
    await api.updateIssue({
      linearOrganizationId: "linear-org",
      issueId: "issue-1",
      stateId: "state-done",
    });

    const request = graphqlRequest(requests[0]!.body);
    assert.match(
      request.query,
      /mutation PaseoIssueUpdate\(\$id: String!, \$input: IssueUpdateInput!\)/u,
    );
    assert.match(request.query, /issueUpdate\(id: \$id, input: \$input\) \{ success \}/u);
    assert.deepEqual(request.variables, {
      id: "issue-1",
      input: { stateId: "state-progress", delegateId: "app-user" },
    });
    assert.deepEqual(graphqlRequest(requests[1]!.body).variables, {
      id: "issue-1",
      input: { stateId: "state-done" },
    });
  });

  it("links a GitHub pull request to an issue", async () => {
    const { api, requests } = apiClient(() =>
      json({ data: { attachmentLinkGitHubPR: { success: true } } }),
    );

    await api.linkGitHubPullRequest({
      linearOrganizationId: "linear-org",
      issueId: "issue-1",
      url: "https://github.com/acme/app/pull/7",
      title: "Fix login",
    });
    await api.linkGitHubPullRequest({
      linearOrganizationId: "linear-org",
      issueId: "issue-1",
      url: "https://github.com/acme/app/pull/8",
    });

    const request = graphqlRequest(requests[0]!.body);
    assert.match(
      request.query,
      /mutation PaseoAttachmentLinkGitHubPR\(\$issueId: String!, \$url: String!, \$title: String\)/u,
    );
    assert.match(
      request.query,
      /attachmentLinkGitHubPR\(issueId: \$issueId, url: \$url, title: \$title\) \{ success \}/u,
    );
    assert.deepEqual(request.variables, {
      issueId: "issue-1",
      url: "https://github.com/acme/app/pull/7",
      title: "Fix login",
    });
    assert.deepEqual(graphqlRequest(requests[1]!.body).variables, {
      issueId: "issue-1",
      url: "https://github.com/acme/app/pull/8",
    });
  });

  it("reports HTTP failures and GraphQL errors as LinearApiError with status and code", async () => {
    const rateLimited = apiClient(() => new Response("slow down", { status: 429 }));
    await assert.rejects(
      rateLimited.api.readTeamStates({ linearOrganizationId: "linear-org", teamId: "team-1" }),
      (error: unknown) =>
        error instanceof LinearApiError &&
        error.status === 429 &&
        error.code === undefined &&
        error.message === "Linear GraphQL HTTP 429",
    );

    const forbidden = apiClient(() =>
      json({
        errors: [
          {
            message: "Entity not found: AgentSession",
            extensions: { code: "FORBIDDEN", type: "invalid input" },
          },
        ],
      }),
    );
    await assert.rejects(
      forbidden.api.updateAgentSession({
        linearOrganizationId: "linear-org",
        agentSessionId: "session-1",
        summary: "x",
      }),
      (error: unknown) =>
        error instanceof LinearApiError &&
        error.status === 200 &&
        error.code === "FORBIDDEN" &&
        error.message === "Linear GraphQL Entity not found: AgentSession",
    );
  });

  it("refreshes an expired token under the connection lock before emitting an activity", async () => {
    const updates: unknown[] = [];
    const requests: Array<{ authorization: string | null; body: string }> = [];
    const connection: LinearConnectionRecord = {
      ...linearConnection(),
      accessToken: "expired-token",
      accessTokenExpiresAt: new Date(1_700_000_000_000),
    };
    let lockedRefreshes = 0;
    const api = createLinearApiClient({
      connectionForLinearOrganization: async () => connection,
      withLinearConnectionRefresh: async (linearOrganizationId, operation) => {
        lockedRefreshes += 1;
        assert.equal(linearOrganizationId, "linear-org");
        return operation(connection, async (update) => {
          updates.push({ connectionId: connection.id, ...update });
        });
      },
      connectionClient: {
        refresh: async () => ({ accessToken: "fresh-token", refreshToken: "next-refresh-token" }),
      },
      now: () => new Date(1_700_000_010_000),
      fetch: async (_url, init) => {
        requests.push({
          authorization: new Headers(init?.headers).get("authorization"),
          body: readableBody(init?.body),
        });
        return json({
          data: { agentActivityCreate: { success: true, agentActivity: { id: "activity-1" } } },
        });
      },
    });

    await api.createAgentActivity({
      linearOrganizationId: "linear-org",
      agentSessionId: "session-1",
      content: { type: "thought", body: "On it" },
      ephemeral: true,
    });

    assert.equal(lockedRefreshes, 1);
    assert.deepEqual(updates, [
      {
        connectionId: "connection-1",
        accessToken: "fresh-token",
        refreshToken: "next-refresh-token",
      },
    ]);
    assert.deepEqual(
      requests.map((request) => request.authorization),
      ["Bearer fresh-token"],
    );
    assert.match(requests[0]!.body, /agentActivityCreate/u);
  });
});

function linearConnection(): LinearConnectionRecord {
  return {
    id: "connection-1",
    organizationId: "hub-org",
    slug: "acme-linear",
    providerApplicationId: "linear-app",
    linearOrganizationId: "linear-org",
    linearOrganizationName: "Acme",
    appUserId: "app-user",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accessTokenExpiresAt: null,
    scopes: GRANTED_SCOPES,
  };
}

/** An API client over a usable token, recording every GraphQL request it sends. */
function apiClient(respond: () => Response): {
  api: LinearApiClient;
  requests: Array<{ authorization: string | null; body: string }>;
} {
  const requests: Array<{ authorization: string | null; body: string }> = [];
  const connection = linearConnection();
  const api = createLinearApiClient({
    connectionForLinearOrganization: async () => connection,
    withLinearConnectionRefresh: withinLinearRefresh(connection, async () => {}),
    connectionClient: { refresh: async () => ({ accessToken: "unused" }) },
    fetch: async (_url, init) => {
      requests.push({
        authorization: new Headers(init?.headers).get("authorization"),
        body: readableBody(init?.body),
      });
      return respond();
    },
  });
  return { api, requests };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function withinLinearRefresh(
  connection: LinearConnectionRecord,
  updateTokens: (input: UpdateLinearConnectionTokensInput) => Promise<void>,
): Database["withLinearConnectionRefresh"] {
  return async (_linearOrganizationId, operation) =>
    operation(connection, (input) => updateTokens({ connectionId: connection.id, ...input }));
}

function readableUrl(value: RequestInfo | URL): string {
  if (typeof value === "string") return value;
  return value instanceof URL ? value.toString() : value.url;
}

function readableBody(value: BodyInit | null | undefined): string {
  if (typeof value === "string") return value;
  if (value instanceof URLSearchParams) return value.toString();
  return "";
}

function graphqlRequest(value: string): { query: string; variables: unknown } {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("query" in parsed) ||
    typeof parsed.query !== "string"
  ) {
    throw new Error("expected GraphQL request");
  }
  return { query: parsed.query, variables: "variables" in parsed ? parsed.variables : undefined };
}
