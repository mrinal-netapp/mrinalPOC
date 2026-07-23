import { AGENT_RUNTIME_BASE_URL } from "@/consts/api.consts";

export type RuntimeQueryParams = Record<string, string>;

/** Config-service agent CRUD (project via x-agent-studio-context header). */
export function agentsConfigPath(suffix = ""): string {
  return `/agents${suffix}`;
}

/** Agent-service runtime paths (project id in URL). */
export function agentsRuntimePath(suffix: string, projectId: string): string {
  return `/projects/${projectId}${suffix}`;
}

/** Append optional query params; omitted/empty maps leave the URL unchanged. */
export function appendQueryParams(url: string, queryParams?: RuntimeQueryParams): string {
  if (!queryParams) {
    return url;
  }

  const entries = Object.entries(queryParams).filter(([, value]) => value.length > 0);
  if (entries.length === 0) {
    return url;
  }

  const qs = new URLSearchParams(Object.fromEntries(entries)).toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * agent-service SSE endpoint:
 *   POST /api/v1/projects/{project_id}/agents/{agent_id}/invoke/stream
 */
export function buildAgentStreamUrl(
  agentId: string,
  projectId: string,
  queryParams?: RuntimeQueryParams,
): string {
  const base = AGENT_RUNTIME_BASE_URL.replace(/\/$/, "");
  const path = `${base}${agentsRuntimePath(`/agents/${agentId}/invoke/stream`, projectId)}`;
  return appendQueryParams(path, queryParams);
}

/**
 * agent-service SSE endpoint:
 *   POST /api/v1/projects/{project_id}/agent-teams/{team_id}/invoke/stream
 */
export function buildAgentTeamStreamUrl(
  teamId: string,
  projectId: string,
  queryParams?: RuntimeQueryParams,
): string {
  const base = AGENT_RUNTIME_BASE_URL.replace(/\/$/, "");
  const path = `${base}${agentsRuntimePath(`/agent-teams/${teamId}/invoke/stream`, projectId)}`;
  return appendQueryParams(path, queryParams);
}
