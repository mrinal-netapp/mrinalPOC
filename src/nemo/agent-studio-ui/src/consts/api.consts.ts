const GATEWAY_CONFIG_API_V1 = "/config/api/v1";
const GATEWAY_WORKFLOW_API_V1 = "/workflow/api/v1";

function deriveGatewayServiceBaseUrl(agentBaseUrl: string, gatewayPath: string): string {
  const trimmed = agentBaseUrl.trim();

  if (!trimmed || trimmed.startsWith("/")) {
    return gatewayPath;
  }

  try {
    const url = new URL(trimmed);
    return `${url.origin}${gatewayPath}`;
  } catch {
    return gatewayPath;
  }
}

/** @see projects-api-reference.md */
export function deriveProjectsBaseUrl(agentBaseUrl: string): string {
  return deriveGatewayServiceBaseUrl(agentBaseUrl, GATEWAY_CONFIG_API_V1);
}

/** Workflow-engine membership writes (Temporal). */
export function deriveWorkflowBaseUrl(agentBaseUrl: string): string {
  return deriveGatewayServiceBaseUrl(agentBaseUrl, GATEWAY_WORKFLOW_API_V1);
}

function resolveGatewayPathFromConfigBaseUrl(configBaseUrl: string, gatewayPath: string): string | null {
  const trimmed = configBaseUrl.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.pathname === GATEWAY_CONFIG_API_V1 || url.pathname.endsWith(GATEWAY_CONFIG_API_V1)) {
      return `${url.origin}${gatewayPath}`;
    }
    if (url.pathname.includes("config-service")) {
      return `${url.origin}${gatewayPath}`;
    }
    return null;
  } catch {
    // Relative config base — use same-origin gateway prefix (Vite proxy in dev).
  }

  if (trimmed === GATEWAY_CONFIG_API_V1 || trimmed.endsWith(GATEWAY_CONFIG_API_V1)) {
    return gatewayPath;
  }

  if (trimmed.includes("config-service")) {
    return gatewayPath;
  }

  return null;
}

/**
 * Resolves a configured base URL to an absolute URL.
 *
 * Same-origin dev-proxy paths (e.g. "/__config", "/__agent_runtime") are
 * prefixed with the current window origin so calls work regardless of which
 * port the Vite dev server bound to (5173, 5174, …). Vite auto-increments the
 * port when the default is taken, so hardcoding a host in `.env` breaks the
 * moment a second dev server is running. Absolute URLs (http/https) and the
 * no-window case (tests / SSR) are returned unchanged.
 *
 * Needed specifically for the config + runtime bases because their endpoints
 * build the full URL and hand it to the shared `apiSlice` base query — a
 * relative value would be (incorrectly) joined onto the config-service base.
 */
export function resolveSameOriginBase(url: string): string {
  /* v8 ignore next -- SSR / no-window path is untestable in jsdom */
  if (url.startsWith('/') && typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}${url}`;
  }
  return url;
}

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();
/* v8 ignore start -- import.meta.env is resolved at module load time; the fallback branch is untestable without a dynamic re-import */
export const BASE_URL = configuredBaseUrl || 'http://localhost:3000/api/v1';
/* v8 ignore stop */

const configuredUtilitiesBaseUrl = import.meta.env.VITE_UTILITIES_API_BASE_URL?.trim();
/* v8 ignore start -- env-var fallback is module-level; untestable without a dynamic re-import */
export const UTILITIES_BASE_URL = configuredUtilitiesBaseUrl || 'http://localhost:3400/api/v1/utilities';
/* v8 ignore stop */

const configuredAgentBaseUrl = import.meta.env.VITE_AGENT_API_BASE_URL?.trim();
/* v8 ignore start -- env-var fallback is module-level; untestable without a dynamic re-import */
export const AGENT_BASE_URL = configuredAgentBaseUrl || '/api/agent';
/* v8 ignore stop */

/** Agent-service invoke / sessions / traces (distinct from legacy AGENT_BASE_URL RFC demo). */
const configuredAgentRuntimeBaseUrl = import.meta.env.VITE_AGENT_RUNTIME_API_BASE_URL?.trim();
/* v8 ignore start -- env-var fallback is module-level; untestable without a dynamic re-import */
export const AGENT_RUNTIME_BASE_URL = resolveSameOriginBase(
  configuredAgentRuntimeBaseUrl || AGENT_BASE_URL,
);
/* v8 ignore stop */

/** KB retrieval search/metadata (gateway prefix `/kb`, distinct from config-service). */
const configuredKbRetrievalBaseUrl = import.meta.env.VITE_KB_RETRIEVAL_API_BASE_URL?.trim();
/* v8 ignore start -- env-var fallback is module-level; untestable without a dynamic re-import */
export const KB_RETRIEVAL_BASE_URL =
  configuredKbRetrievalBaseUrl || '/kb/api/v1';
/* v8 ignore stop */
const configuredAgentsConfigBaseUrl = import.meta.env.VITE_AGENTS_CONFIG_API_BASE_URL?.trim();
/* v8 ignore start -- env-var fallback is module-level; untestable without a dynamic re-import */
/** Base URL for the Agent Config Service (agent + agent-team CRUD). */
export const AGENTS_CONFIG_BASE_URL = resolveSameOriginBase(
  configuredAgentsConfigBaseUrl || BASE_URL.replace(/\/api\/v1.*$/, ''),
);
/* v8 ignore stop */

const configuredProjectsBaseUrl =
  resolveGatewayPathFromConfigBaseUrl(configuredBaseUrl ?? "", GATEWAY_CONFIG_API_V1) ??
  deriveProjectsBaseUrl(AGENT_BASE_URL);
/* v8 ignore start -- env-var fallback is module-level; untestable without a dynamic re-import */
export const PROJECTS_BASE_URL = configuredProjectsBaseUrl;
export const WORKFLOW_BASE_URL =
  resolveGatewayPathFromConfigBaseUrl(configuredBaseUrl ?? "", GATEWAY_WORKFLOW_API_V1) ??
  deriveWorkflowBaseUrl(AGENT_BASE_URL);
/* v8 ignore stop */

const configuredModelServiceBaseUrl = import.meta.env.VITE_MODEL_SERVICE_BASE_URL?.trim();
/* v8 ignore start -- env-var fallback is module-level; untestable without a dynamic re-import */
/** Dev default uses Vite same-origin proxy (see vite.config) so browser calls avoid CORS. */
export const MODEL_SERVICE_BASE_URL =
  configuredModelServiceBaseUrl ||
  (import.meta.env.DEV ? "/__model_service" : "http://127.0.0.1:8000");
/* v8 ignore stop */

export const NEMO_CONTEXT_HEADER = 'x-agent-studio-context';

export const DEFAULT_NEMO_CONTEXT = {
  // project_id is no longer sourced from a build-time env. It's always '' here;
  // the active project comes from the Redux store (projectContext.activeProjectId).
  // Kept on the object for legacy consumers (e.g. agents-runtime code paths)
  // until they're migrated to read from the store directly.
  project_id: '',
  user_id: import.meta.env.VITE_USER_ID ?? '',
  org_id: import.meta.env.VITE_ORG_ID ?? '',
};

export const POLLING_INTERVAL = 20_000;
/** Poll faster while a dataset import/re-import is in flight. */
export const IMPORT_POLLING_INTERVAL = 2_000;
export const DEFAULT_PAGE_SIZE = 20;
