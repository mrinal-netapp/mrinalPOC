import {
  createApi,
  fetchBaseQuery,
} from '@reduxjs/toolkit/query/react';
import type {
  BaseQueryFn,
  FetchArgs,
  FetchBaseQueryError,
} from '@reduxjs/toolkit/query/react';

import {
  BASE_URL,
  DEFAULT_NEMO_CONTEXT,
  NEMO_CONTEXT_HEADER,
} from '@/consts/api.consts';
import { getUserIdFromAccessToken } from '@/utils/accessTokenClaims';
import { resolveAccessToken } from './auth-access-token';

type NemoContext = typeof DEFAULT_NEMO_CONTEXT & { project_id: string };

/** Minimal store shape read by resolveNemoContext — avoids importing from store/. */
type NemoContextStoreState = {
  projectContext?: {
    activeProject?: {
      id: string;
    };
  };
};

type AuthTokenBridge = {
  getAccessToken: () => string | null;
  refreshToken: () => Promise<string | null>;
  onAuthFailure?: () => void | Promise<void>;
};

let authTokenBridge: AuthTokenBridge | null = null;

const retriedObjectRequests = new WeakSet<object>();
const retriedUrlRequests = new Set<string>();

export function setAuthTokenBridge(bridge: AuthTokenBridge): void {
  authTokenBridge = bridge;
}

export function clearAuthTokenBridge(): void {
  authTokenBridge = null;
  retriedUrlRequests.clear();
}

function wasRetried(args: string | FetchArgs): boolean {
  if (typeof args === "string") {
    return retriedUrlRequests.has(args);
  }
  return retriedObjectRequests.has(args);
}

function markRetried(args: string | FetchArgs): void {
  if (typeof args === "string") {
    retriedUrlRequests.add(args);
  } else {
    retriedObjectRequests.add(args);
  }
}

function buildRetryArgs(
  args: string | FetchArgs,
  accessToken: string,
): string | FetchArgs {
  if (typeof args === "string") {
    return {
      url: args,
      headers: { Authorization: `Bearer ${accessToken}` },
    };
  }

  const headers =
    args.headers instanceof Headers
      ? new Headers(args.headers)
      : { ...(args.headers as Record<string, string> | undefined) };

  if (headers instanceof Headers) {
    headers.set("Authorization", `Bearer ${accessToken}`);
    return { ...args, headers };
  }

  return {
    ...args,
    headers: {
      ...headers,
      Authorization: `Bearer ${accessToken}`,
    },
  };
}

export function encodeNemoContext(ctx: NemoContext): string {
  const bytes = new TextEncoder().encode(JSON.stringify(ctx));
  return btoa(bytes.reduce((s, byte) => s + String.fromCodePoint(byte), ''));
}

export function resolveNemoContext(getState?: () => unknown): NemoContext {
  const state = getState?.() as NemoContextStoreState | undefined;
  const project_id = state?.projectContext?.activeProject?.id ?? '';

  return {
    project_id,
    user_id: DEFAULT_NEMO_CONTEXT.user_id,
    org_id: DEFAULT_NEMO_CONTEXT.org_id,
  };
}

/**
 * Shared prepareHeaders implementation for all RTK Query API instances.
 * Attaches the Bearer JWT from the auth token bridge and the nemo-context
 * header. The active project id is resolved dynamically from the store, while
 * the user id is derived from the access token when available.
 */
export function buildNemoContextHeaders(
  headers: Headers,
  getState?: () => unknown,
): Headers {
  // Prefer the OIDC bridge token (when platform auth is enabled), and fall back
  // to the runtime/dev access token (VITE_ACCESS_TOKEN) when it is not.
  const accessToken = authTokenBridge?.getAccessToken() ?? resolveAccessToken();
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }

  const { project_id, org_id } = resolveNemoContext(getState);
  const userIdFromToken = getUserIdFromAccessToken(accessToken);
  const user_id = userIdFromToken ?? DEFAULT_NEMO_CONTEXT.user_id;

  if (project_id && user_id && org_id) {
    headers.set(
      NEMO_CONTEXT_HEADER,
      encodeNemoContext({ project_id, user_id, org_id }),
    );
  }

  return headers;
}

/**
 * Returns `true` when the query should be skipped.
 * Skips when there is no resolvable user, or when an additional custom
 * condition evaluates to `true`.
 *
 * `org_id` is intentionally NOT part of this gate: it is sourced from the
 * build-time `VITE_ORG_ID` (empty in the standard image build) and is never
 * required for auth — the gateway authenticates via the bearer token /
 * injected `X-User-ID`, and the `x-agent-studio-context` header is only sent
 * when all of project/user/org are present anyway. Requiring it here silently
 * skipped runtime queries (e.g. the playground session list) in deployments
 * that don't inject `VITE_ORG_ID`.
 */
export function shouldSkipQuery(customCondition = false): boolean {
  const accessToken = authTokenBridge?.getAccessToken() ?? null;
  const userId = getUserIdFromAccessToken(accessToken) ?? DEFAULT_NEMO_CONTEXT.user_id;
  return !userId || customCondition;
}

/**
 * Creates a baseQuery wrapped with reauth handling for the given baseUrl.
 * Shared across all RTK Query API instances to ensure consistent 401 behavior.
 */
export function createBaseQueryWithReauth(baseUrl: string): BaseQueryFn<
  string | FetchArgs,
  unknown,
  FetchBaseQueryError
> {
  const innerBaseQuery = fetchBaseQuery({
    baseUrl,
    credentials: "include",
    prepareHeaders: (headers, api) => buildNemoContextHeaders(headers, api.getState),
  });

  return async (args, api, extraOptions) => {
    let result = await innerBaseQuery(args, api, extraOptions);

    if (result.error?.status === 401 && authTokenBridge != null && !wasRetried(args)) {
      markRetried(args);
      try {
        const refreshedToken = await authTokenBridge.refreshToken();
        if (refreshedToken == null) {
          throw new Error("Token refresh returned no access token");
        }
        const retryArgs = buildRetryArgs(args, refreshedToken);
        result = await innerBaseQuery(retryArgs, api, extraOptions);
      } catch (err) {
        console.error({ event: 'auth.token_refresh_failed_on_401', error: err });
        try {
          await authTokenBridge.onAuthFailure?.();
        } catch (failureErr) {
          console.error({ event: 'auth.auth_failure_handler_failed', error: failureErr });
        }
      }
    }

    return result;
  };
}

const baseQueryWithReauth = createBaseQueryWithReauth(BASE_URL);

export const apiSlice = createApi({
  reducerPath: 'api',
  baseQuery: baseQueryWithReauth,
  tagTypes: [
    'DataSource',
    'DataSourceDetail',
    'DataSourceDatasets',
    'Dataset',
    'DatasetDetail',
    'DatasetSnapshots',
    'DatasetManifests',
    'DatasetKBs',
    'KnowledgeBase',
    'KBDetail',
    'KBSnapshots',
    'Agent',
    'AgentDetail',
    'AgentTeam',
    'AgentTeamDetail',
    'AgentSession',
    'AgentTrace',
    'Model',
    'ModelDetail',
    'ModelProvider',
    'Tool',
    'ToolDetail',
    'Credential',
    'CredentialDetail',
    'Project',
    'ProjectList',
    'ProjectMembers',
    'UserProjects',
    'ProviderCatalog',
    'EvalTemplate',
    'EvalRun',
    'TestCase',
  ],
  endpoints: () => ({}),
});

export const { reducer: apiReducer, middleware: apiMiddleware } = apiSlice;
