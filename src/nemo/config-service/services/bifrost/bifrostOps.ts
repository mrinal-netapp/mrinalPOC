/**
 * Bifrost API helpers — thin wrappers over Bifrost's control-plane
 * endpoints. Covers teams, virtual keys, budgets, rate limits, model
 * configs, and routing rules. Provider-specific helpers live in
 * ``bifrostProviderOps.ts``; MCP-client helpers in ``bifrostMcpOps.ts``;
 * higher-level per-project orchestration in ``bifrostProjectGovernance.ts``.
 *
 * Note: the underlying Bifrost HTTP paths are still ``/api/governance/*``
 * — that's Bifrost's own naming for this surface. AgentStudio doesn't
 * inherit the "governance" framing on its own side because creating a
 * virtual key, setting a budget, or wiring a routing rule are part of
 * core security posture / control-plane config, not a separate
 * governance concept.
 */
import axios, { AxiosInstance } from 'axios';
import { resolveGatewayApiKey, resolveGatewayBaseUrl } from '../gatewayClient';

function authHeaders(): Record<string, string> {
  const key = resolveGatewayApiKey();
  if (!key) return {};
  return { Authorization: `Bearer ${key}`, 'x-api-key': key };
}

export function createBifrostClient(timeoutMs = 15000): AxiosInstance {
  return axios.create({
    baseURL: resolveGatewayBaseUrl(),
    timeout: timeoutMs,
    headers: authHeaders(),
  });
}

export async function listTeams(client?: AxiosInstance): Promise<Array<Record<string, unknown>>> {
  const c = client || createBifrostClient();
  const resp = await c.get('/api/governance/teams');
  const data = resp.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.teams)) return data.teams;
  return [];
}

export async function createTeam(
  body: Record<string, unknown>,
  client?: AxiosInstance,
): Promise<Record<string, unknown>> {
  const c = client || createBifrostClient();
  const resp = await c.post('/api/governance/teams', body);
  const data = resp.data as Record<string, unknown>;
  return (data?.team as Record<string, unknown>) || data;
}

export async function getTeam(
  teamId: string,
  client?: AxiosInstance,
): Promise<Record<string, unknown> | null> {
  const c = client || createBifrostClient();
  try {
    const resp = await c.get(`/api/governance/teams/${encodeURIComponent(teamId)}`);
    const data = resp.data as Record<string, unknown>;
    return (data?.team as Record<string, unknown>) || data;
  } catch (err: any) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

export async function listVirtualKeys(client?: AxiosInstance): Promise<unknown> {
  const c = client || createBifrostClient();
  const resp = await c.get('/api/governance/virtual-keys');
  return resp.data;
}

export async function getVirtualKey(
  vkId: string,
  client?: AxiosInstance,
): Promise<Record<string, unknown> | null> {
  const c = client || createBifrostClient();
  try {
    const resp = await c.get(`/api/governance/virtual-keys/${encodeURIComponent(vkId)}`);
    const data = resp.data as Record<string, unknown>;
    return (data?.virtual_key as Record<string, unknown>) || data?.key || data;
  } catch (err: any) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

export function listVirtualKeysArray(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj?.virtual_keys)) return obj.virtual_keys as Array<Record<string, unknown>>;
  if (Array.isArray(obj?.keys)) return obj.keys as Array<Record<string, unknown>>;
  return [];
}

export async function createVirtualKey(body: Record<string, unknown>, client?: AxiosInstance): Promise<unknown> {
  const c = client || createBifrostClient();
  const resp = await c.post('/api/governance/virtual-keys', body);
  return resp.data;
}

export async function updateVirtualKey(
  vkId: string,
  body: Record<string, unknown>,
  client?: AxiosInstance,
): Promise<unknown> {
  const c = client || createBifrostClient();
  const resp = await c.put(
    `/api/governance/virtual-keys/${encodeURIComponent(vkId)}`,
    body,
  );
  return resp.data;
}

export async function deleteVirtualKey(vkId: string, client?: AxiosInstance): Promise<void> {
  const c = client || createBifrostClient();
  await c.delete(`/api/governance/virtual-keys/${encodeURIComponent(vkId)}`);
}

/**
 * Start native VK rotation: same virtual-key id, dual-credential grace window.
 * Returns the new secondary `sk-bf-*` bearer (shape varies by Bifrost version).
 */
export async function rotateVirtualKey(
  vkId: string,
  body: Record<string, unknown> = {},
  client?: AxiosInstance,
): Promise<unknown> {
  const c = client || createBifrostClient();
  const resp = await c.post(
    `/api/governance/virtual-keys/${encodeURIComponent(vkId)}/rotate`,
    body,
  );
  return resp.data;
}

/**
 * Finalize rotation: promote secondary credential to primary and revoke the old primary.
 */
export async function promoteSecondaryVirtualKey(
  vkId: string,
  client?: AxiosInstance,
): Promise<unknown> {
  const c = client || createBifrostClient();
  const resp = await c.post(
    `/api/governance/virtual-keys/${encodeURIComponent(vkId)}/promote-secondary`,
    {},
  );
  return resp.data;
}

/**
 * Delete a Bifrost governance team. 404-tolerant (treats already-deleted
 * as success) so the caller can safely re-run project teardown.
 */
export async function deleteTeam(teamId: string, client?: AxiosInstance): Promise<void> {
  const c = client || createBifrostClient();
  try {
    await c.delete(`/api/governance/teams/${encodeURIComponent(teamId)}`);
  } catch (err: any) {
    if (err.response?.status === 404) return;
    throw err;
  }
}

export async function listBudgets(client?: AxiosInstance): Promise<unknown> {
  const c = client || createBifrostClient();
  const resp = await c.get('/api/governance/budgets');
  return resp.data;
}

export async function listRateLimits(client?: AxiosInstance): Promise<unknown> {
  const c = client || createBifrostClient();
  const resp = await c.get('/api/governance/rate-limits');
  return resp.data;
}

export async function listModelConfigs(client?: AxiosInstance): Promise<unknown> {
  const c = client || createBifrostClient();
  const resp = await c.get('/api/governance/model-configs');
  return resp.data;
}

export async function createModelConfig(body: Record<string, unknown>, client?: AxiosInstance): Promise<unknown> {
  const c = client || createBifrostClient();
  const resp = await c.post('/api/governance/model-configs', body);
  return resp.data;
}

export async function updateModelConfig(
  configId: string,
  body: Record<string, unknown>,
  client?: AxiosInstance,
): Promise<unknown> {
  const c = client || createBifrostClient();
  const resp = await c.put(
    `/api/governance/model-configs/${encodeURIComponent(configId)}`,
    body,
  );
  return resp.data;
}

export async function deleteModelConfig(configId: string, client?: AxiosInstance): Promise<void> {
  const c = client || createBifrostClient();
  await c.delete(
    `/api/governance/model-configs/${encodeURIComponent(configId)}`,
  );
}

/** Filters accepted by {@link getLogStats} (subset of Bifrost's log query). */
export interface BifrostLogStatsFilters {
  /** Comma-separated Bifrost provider names (e.g. `azure`, `as-openai-compat-<short>`). */
  providers?: string;
  /** Comma-separated model identifiers as logged on the wire. */
  models?: string;
  /** Comma-separated Bifrost virtual-key ids. */
  virtualKeyIds?: string;
  /** Inclusive lower bound (RFC3339). Omit for all retained logs. */
  startTime?: string;
  /** Inclusive upper bound (RFC3339). */
  endTime?: string;
}

/**
 * Aggregated request statistics returned by Bifrost's logs store. `success_rate`
 * / `user_facing_success_rate` are percentages (0-100); `average_latency` is in
 * milliseconds; `total_cost` is USD.
 */
export interface BifrostLogStats {
  total_requests: number;
  total_tokens: number;
  total_cost: number;
  average_latency: number;
  success_rate: number;
  user_facing_success_rate?: number;
  user_facing_total_requests?: number;
}

/**
 * Fetch aggregated request statistics from Bifrost's logs store
 * (`GET /api/logs/stats`) for the logs matching `filters`. Powers per-model
 * cost / requests / latency / success-rate on the model detail page.
 *
 * Requires Bifrost's `logs_store` to be enabled — it is in AgentStudio's chart
 * (Postgres-backed, 90-day retention), so an empty/omitted time range yields
 * up to the last 90 days of aggregates. Callers should treat a thrown error as
 * "stats unavailable" (logs store disabled, gateway unreachable) rather than a
 * hard failure.
 */
export async function getLogStats(
  filters: BifrostLogStatsFilters = {},
  client?: AxiosInstance,
): Promise<BifrostLogStats> {
  const c = client || createBifrostClient();
  const params = new URLSearchParams();
  if (filters.providers) params.set('providers', filters.providers);
  if (filters.models) params.set('models', filters.models);
  if (filters.virtualKeyIds) params.set('virtual_key_ids', filters.virtualKeyIds);
  if (filters.startTime) params.set('start_time', filters.startTime);
  if (filters.endTime) params.set('end_time', filters.endTime);
  const qs = params.toString();
  const resp = await c.get(`/api/logs/stats${qs ? `?${qs}` : ''}`);
  const d = (resp.data ?? {}) as Partial<BifrostLogStats>;
  const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    total_requests: num(d.total_requests),
    total_tokens: num(d.total_tokens),
    total_cost: num(d.total_cost),
    average_latency: num(d.average_latency),
    success_rate: num(d.success_rate),
    user_facing_success_rate:
      d.user_facing_success_rate != null ? num(d.user_facing_success_rate) : undefined,
    user_facing_total_requests:
      d.user_facing_total_requests != null ? num(d.user_facing_total_requests) : undefined,
  };
}

/** Prompt vs completion token totals sampled from Bifrost's per-request logs. */
export interface BifrostTokenSplit {
  /** Summed `token_usage.prompt_tokens` across the sampled requests. */
  promptTokens: number;
  /** Summed `token_usage.completion_tokens` across the sampled requests. */
  completionTokens: number;
  /** Number of log entries actually sampled. */
  sampledRequests: number;
}

/**
 * Sample recent per-request logs (`GET /api/logs`) and sum their prompt vs
 * completion tokens.
 *
 * Bifrost's aggregate stats endpoint only exposes a combined `total_tokens`,
 * but pricing needs an input/output split (input and output rates differ). The
 * caller derives an input:output ratio from this sample and applies it to the
 * authoritative aggregate total — exact for low-volume models (the whole
 * population fits in one sample) and a close estimate otherwise. Used to price
 * traffic from a model's configured per-1M rates when Bifrost itself logged a
 * zero cost (e.g. custom deployment names it has no built-in pricing for).
 */
export async function getLogTokenSplit(
  filters: BifrostLogStatsFilters & { limit?: number } = {},
  client?: AxiosInstance,
): Promise<BifrostTokenSplit> {
  const c = client || createBifrostClient();
  const params = new URLSearchParams();
  if (filters.providers) params.set('providers', filters.providers);
  if (filters.models) params.set('models', filters.models);
  if (filters.virtualKeyIds) params.set('virtual_key_ids', filters.virtualKeyIds);
  if (filters.startTime) params.set('start_time', filters.startTime);
  if (filters.endTime) params.set('end_time', filters.endTime);
  params.set('limit', String(filters.limit && filters.limit > 0 ? filters.limit : 100));
  const resp = await c.get(`/api/logs?${params.toString()}`);
  const d = (resp.data ?? {}) as { logs?: Array<Record<string, unknown>> };
  const logs = Array.isArray(d.logs) ? d.logs : [];
  const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  let promptTokens = 0;
  let completionTokens = 0;
  for (const entry of logs) {
    const tu = (entry?.token_usage ?? {}) as Record<string, unknown>;
    promptTokens += num(tu.prompt_tokens);
    completionTokens += num(tu.completion_tokens);
  }
  return { promptTokens, completionTokens, sampledRequests: logs.length };
}

// NOTE: Bifrost routing-rule helpers (listRoutingRules,
// createRoutingRule, deleteRoutingRule, nextGlobalRoutingPriority,
// nextTeamRoutingPriority, routingRuleName) used to live here. They
// supported a UUID-based model identifier on the wire (Bifrost would
// match `request.model == "<uuid>"` via a per-model routing rule and
// resolve it to the provider + provider key + upstream model).
//
// They were removed because AgentStudio sends the provider-prefixed
// `gatewayModelId` (e.g. `azure/<binding>`) on every chat-completion
// call -- both from agent-service (via
// `llmproxy_gateway_model_id_with_sdk_prefix`) and from the playground
// (`POST /models/:id/infer`, computed from `model.gatewayModelId`).
// Bifrost natively accepts that form without any routing rule, so the
// per-model rule was redundant write-only state (the
// `routingRuleId` / `routingPriority` fields written to
// `rateCardOverride._gateway` were never read back anywhere).
//
// If we ever need true UUID-based routing (e.g. UI sends bare model
// UUIDs and we want Bifrost to dispatch transparently), re-add these
// helpers and re-wire `BifrostGatewayClient.addModel` /
// `deleteModel`. Tracked as an out-of-scope follow-up in
// docs/design/bifrost-migration.md.
