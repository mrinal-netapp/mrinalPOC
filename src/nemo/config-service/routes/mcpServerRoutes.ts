import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import 'reflect-metadata';
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../db/postgres';
import { MCPServer, MCPConnectionParam, MCPSecretRef } from '../models/MCPServer';
import { MCPServerHistory } from '../models/history/MCPServerHistory';
import { createMCPServerValidator, updateMCPServerValidator } from '../validators/mcpServerValidator';
import { validationResult } from 'express-validator';
import { Not, In, Repository } from 'typeorm';
import { validateProject } from '../middleware/projectValidator';
import { getLLMGatewayClient } from '../services/gatewayClient';
import { getCredentialService } from '../services/CredentialService';
import { getMCPRuntimeManager } from '../services/MCPRuntimeManager';
import {
  getCatalogEntry,
  WEB_SEARCH_CATALOG_ID,
  SEARXNG_WEB_SEARCH_CATALOG_ID,
} from '../catalog/mcpServerCatalog';
import {
  applyForEntity,
  removeForSource,
  hasDependents,
  summaryForTargets,
  listDependents,
} from '../services/ReferenceEdgeService';
import { safeLog } from '../utils/safeStrings';
import { mergePlatformMcpExtraHeaders } from '../catalog/platformMcpDefaults';
import { validateManagedMcpConfig } from '../services/managedMcpConfigValidator';
import rateLimit from 'express-rate-limit';

const router = Router({ mergeParams: true });
const WEB_SEARCH_ENABLED = String(process.env.WEB_SEARCH_MCP_ENABLED || '').toLowerCase() === 'true';
const validateConnectionRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.params.projectId}:${req.ip || 'unknown'}`,
  message: { success: false, message: 'Too many validation requests. Please retry in a minute.' },
});

type SupportedValidateTransport = 'http' | 'sse' | 'streamable-http';

function parseValidateTransport(rawTransport: unknown): SupportedValidateTransport | null {
  if (rawTransport === 'http' || rawTransport === 'sse' || rawTransport === 'streamable-http') {
    return rawTransport;
  }
  return null;
}

function isPrivateAddress(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1') return true;
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4Match) return false;
  const [a, b] = [Number(ipv4Match[1]), Number(ipv4Match[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function validatePublicHttpUrl(rawUrl: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ok: false, message: 'url is required for validation' };
  }
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, message: 'Only http/https MCP URLs are supported for validation' };
    }
    if (!parsed.hostname || isPrivateAddress(parsed.hostname)) {
      return { ok: false, message: 'Private/local MCP URLs are not allowed for validation' };
    }
    return { ok: true, value: parsed.toString() };
  } catch {
    return { ok: false, message: 'Invalid MCP URL' };
  }
}

function parseBoundedInt(
  rawValue: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
  key: string,
): number {
  if (rawValue === undefined || rawValue === '') return defaultValue;
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function normalizeWebSearchManagedConfig(
  envOverrides: Record<string, string> | undefined,
): Record<string, string> {
  const normalized = { ...(envOverrides || {}) };
  if (!normalized.TAVILY_API_KEY || normalized.TAVILY_API_KEY.trim() === '') {
    throw new Error('TAVILY_API_KEY is required for web_search_mcp');
  }

  const timeoutMs = parseBoundedInt(normalized.TAVILY_TIMEOUT_MS, 10000, 1000, 30000, 'TAVILY_TIMEOUT_MS');
  const maxRetries = parseBoundedInt(normalized.TAVILY_MAX_RETRIES, 1, 0, 3, 'TAVILY_MAX_RETRIES');
  const maxResults = parseBoundedInt(normalized.TAVILY_MAX_RESULTS, 5, 1, 10, 'TAVILY_MAX_RESULTS');

  normalized.TAVILY_TIMEOUT_MS = String(timeoutMs);
  normalized.TAVILY_MAX_RETRIES = String(maxRetries);
  normalized.TAVILY_MAX_RESULTS = String(maxResults);
  normalized.TAVILY_ALLOWED_DOMAINS = (normalized.TAVILY_ALLOWED_DOMAINS || '').trim();
  return normalized;
}

function normalizeWebSearchAllowedTools(
  allowedTools: string[] | undefined,
): string[] | undefined {
  if (!allowedTools?.length) return allowedTools;
  // Backward compatibility: earlier default used `web_search`, but Tavily exposes `tavily_*` tools.
  return allowedTools.map((tool) => (tool === 'web_search' ? 'tavily_search' : tool));
}

function normalizeSearxngManagedConfig(
  envOverrides: Record<string, string> | undefined,
): Record<string, string> {
  const normalized = { ...(envOverrides || {}) };
  const searxngUrl = (normalized.SEARXNG_URL || normalized.SEARXNG_BASE_URL || '').trim();
  if (!searxngUrl) {
    throw new Error('SEARXNG_URL (or SEARXNG_BASE_URL) is required for searxng_web_search_mcp');
  }
  const timeoutMs = parseBoundedInt(normalized.SEARXNG_TIMEOUT_MS, 10000, 1000, 30000, 'SEARXNG_TIMEOUT_MS');
  const maxResults = parseBoundedInt(normalized.SEARXNG_MAX_RESULTS, 5, 1, 10, 'SEARXNG_MAX_RESULTS');
  const safeSearch = parseBoundedInt(normalized.SEARXNG_SAFE_SEARCH, 1, 0, 2, 'SEARXNG_SAFE_SEARCH');

  normalized.SEARXNG_URL = searxngUrl;
  // Keep legacy key for backward compatibility with existing records.
  normalized.SEARXNG_BASE_URL = searxngUrl;
  normalized.SEARXNG_TIMEOUT_MS = String(timeoutMs);
  normalized.SEARXNG_MAX_RESULTS = String(maxResults);
  normalized.SEARXNG_SAFE_SEARCH = String(safeSearch);
  normalized.SEARXNG_ENGINES = (normalized.SEARXNG_ENGINES || '').trim();
  return normalized;
}

function buildLlmproxyGatewayServerName(projectId: string, name: string): string {
  return `${projectId}_${name}`;
}

function buildK8sResourceName(projectId: string, serverName: string): string {
  const prefix = `mcp-${projectId.substring(0, 8)}`;
  const safeName = serverName.toLowerCase().replace(/_/g, '-').replace(/[^a-z0-9-]/g, '');
  const maxSuffix = 63 - prefix.length - 1;
  return `${prefix}-${safeName.substring(0, maxSuffix)}`;
}

function splitEnvVars(
  envOverrides: Record<string, string> | undefined,
  envSchema: { name: string; secret: boolean }[],
): { secretEnvVars: Record<string, string>; nonSecretEnvVars: Record<string, string> } {
  const secretEnvVars: Record<string, string> = {};
  const nonSecretEnvVars: Record<string, string> = {};
  if (!envOverrides) return { secretEnvVars, nonSecretEnvVars };

  const secretKeys = new Set(envSchema.filter((e) => e.secret).map((e) => e.name));
  for (const [key, value] of Object.entries(envOverrides)) {
    if (secretKeys.has(key)) {
      secretEnvVars[key] = value;
    } else {
      nonSecretEnvVars[key] = value;
    }
  }
  return { secretEnvVars, nonSecretEnvVars };
}

async function resolveSecretRefValue(
  projectId: string,
  secretRef: MCPSecretRef | undefined,
  credentialCache: Map<string, Promise<Record<string, string> | null>>,
): Promise<string | undefined> {
  if (!secretRef?.credentialId || !secretRef.field) return undefined;
  if (!credentialCache.has(secretRef.credentialId)) {
    credentialCache.set(secretRef.credentialId, resolveCredentialData(projectId, secretRef.credentialId));
  }
  const credentialData = await credentialCache.get(secretRef.credentialId)!;
  return credentialData?.[secretRef.field];
}

async function resolveParamValue(
  projectId: string,
  param: MCPConnectionParam,
  credentialCache: Map<string, Promise<Record<string, string> | null>>,
): Promise<string | undefined> {
  if (param.enabled === false) return undefined;
  if (param.secretRef) {
    return resolveSecretRefValue(projectId, param.secretRef, credentialCache);
  }
  return param.value;
}

/** Accept staticHeaders object or JSON string from the UI. */
function normalizeStaticHeaders(input: unknown): Record<string, string> | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed || trimmed === '{}') return {};
    try {
      return coerceHeaderMap(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      return undefined;
    }
  }
  return coerceHeaderMap(input as Record<string, unknown>);
}

// HTTP header names are constrained to ASCII tokens (RFC 7230 §3.2.6) — no
// special prototype names appear in valid headers, so anything matching this
// regex is also automatically safe against prototype-pollution writes into
// the resulting header map. Anything else is rejected (CodeQL
// js/remote-property-injection).
const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function isSafeHeaderName(name: string): boolean {
  return HTTP_HEADER_NAME.test(name);
}

/** Normalize UI staticHeaders / header param values to string map for Bifrost. */
function coerceHeaderMap(raw?: Record<string, unknown> | Record<string, string> | null): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    const key = String(k).trim();
    if (!key || !isSafeHeaderName(key)) continue;
    out[key] = String(v);
  }
  return out;
}

async function buildResolvedConnection(
  projectId: string,
  server: Partial<MCPServer>,
): Promise<{ resolvedUrl?: string; resolvedHeaders: Record<string, string> }> {
  const credentialCache = new Map<string, Promise<Record<string, string> | null>>();
  const headers: Record<string, string> = coerceHeaderMap(server.staticHeaders);

  if (!server.url) {
    for (const param of server.headerParams || []) {
      const name = (param.name || '').trim();
      if (!name || !isSafeHeaderName(name)) continue;
      const value = await resolveParamValue(projectId, param, credentialCache);
      if (value === undefined || value === null || value === '') continue;
      headers[name] = value;
    }
    if (server.authConfig?.secretRef && server.authConfig.keyName) {
      const authSecret = await resolveSecretRefValue(projectId, server.authConfig.secretRef, credentialCache);
      if (
        authSecret &&
        server.authConfig.location === 'header' &&
        isSafeHeaderName(server.authConfig.keyName)
      ) {
        const prefix = server.authConfig.prefix || '';
        headers[server.authConfig.keyName] = `${prefix}${authSecret}`;
      }
    }
    return { resolvedUrl: undefined, resolvedHeaders: headers };
  }

  const url = new URL(server.url);
  for (const param of server.queryParams || []) {
    const name = (param.name || '').trim();
    if (!name) continue;
    const value = await resolveParamValue(projectId, param, credentialCache);
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(name, value);
  }

  for (const param of server.headerParams || []) {
    const name = (param.name || '').trim();
    if (!name || !isSafeHeaderName(name)) continue;
    const value = await resolveParamValue(projectId, param, credentialCache);
    if (value === undefined || value === null || value === '') continue;
    headers[name] = value;
  }

  if (server.authConfig?.secretRef && server.authConfig.keyName) {
    const authSecret = await resolveSecretRefValue(projectId, server.authConfig.secretRef, credentialCache);
    if (authSecret) {
      const prefix = server.authConfig.prefix || '';
      const rendered = `${prefix}${authSecret}`;
      if (server.authConfig.location === 'header' && isSafeHeaderName(server.authConfig.keyName)) {
        headers[server.authConfig.keyName] = rendered;
      } else if (server.authConfig.location === 'query') {
        url.searchParams.set(server.authConfig.keyName, rendered);
      }
    }
  }

  return {
    resolvedUrl: url.toString(),
    resolvedHeaders: headers,
  };
}

/**
 * Build the full Bifrost-gateway-side config block for a server (URL/
 * credentials/headers/etc.) Exported so the lazy re-registration path
 * in `internalMcpHealthRoutes.ts` produces the same config as the
 * original registration — without it, a circuit-breaker-suspended
 * server with credentials or query/header params would be re-registered
 * with an incomplete config and never recover.
 */
export async function buildGatewayServerConfig(
  projectId: string,
  server: Partial<MCPServer>,
  credentialData?: Record<string, string> | null,
): Promise<Record<string, any>> {
  const config: Record<string, any> = {};

  if (server.transport === 'stdio') {
    config.command = server.command;
    if (server.args?.length) config.args = server.args;
    if (server.env) config.env = server.env;
    config.transport = 'stdio';
  } else {
    const { resolvedUrl, resolvedHeaders } = await buildResolvedConnection(projectId, server);
    config.url = resolvedUrl || server.url;
    config.static_headers = resolvedHeaders;
    config.transport = server.transport === 'sse' ? 'sse' : 'http';
  }

  if (server.authType && server.authType !== 'none') {
    config.auth_type = server.authType;

    if (credentialData) {
      const credentials: Record<string, string> = {};
      if (server.authType === 'api_key' || server.authType === 'bearer_token') {
        credentials.auth_value = credentialData.api_key || credentialData.token || credentialData.auth_value || Object.values(credentialData)[0] || '';
      } else if (server.authType === 'basic') {
        credentials.auth_value = credentialData.username && credentialData.password
          ? `${credentialData.username}:${credentialData.password}`
          : credentialData.auth_value || Object.values(credentialData)[0] || '';
      } else if (server.authType === 'oauth2') {
        if (credentialData.client_id) credentials.client_id = credentialData.client_id;
        if (credentialData.client_secret) credentials.client_secret = credentialData.client_secret;
      }
      if (Object.keys(credentials).length > 0) {
        config.credentials = credentials;
      }
    }
  }

  if (server.transport === 'stdio' && server.staticHeaders) {
    config.static_headers = coerceHeaderMap(server.staticHeaders);
  }

  if (server.allowedTools?.length) {
    config.allowed_tools = server.allowedTools;
  }
  if (server.disallowedTools?.length) {
    config.blocked_tools = server.disallowedTools;
  }

  // Forward-header allowlist (header names Bifrost passes through to the MCP
  // server at tool-execution time). The gateway client maps `extra_headers`
  // onto Bifrost's `allowed_extra_headers`. Platform MCPs always include the
  // identity headers agent-service injects; project MCPs emit only when set.
  if (server.deploymentType === 'platform') {
    config.extra_headers = mergePlatformMcpExtraHeaders(server.extraHeaders);
  } else if (Array.isArray(server.extraHeaders)) {
    config.extra_headers = server.extraHeaders
      .map((name) => (typeof name === 'string' ? name.trim() : ''))
      .filter((name) => name.length > 0);
  }

  return config;
}

function sanitizeConnectionParams(
  params: MCPConnectionParam[] | undefined,
): MCPConnectionParam[] | undefined {
  if (!params?.length) return params;
  return params
    .filter((p) => !!p?.name)
    .map((p) => {
      const sanitized: MCPConnectionParam = {
        name: p.name,
        enabled: p.enabled !== false,
      };
      if (p.secretRef?.credentialId && p.secretRef?.field) {
        sanitized.secretRef = {
          credentialId: p.secretRef.credentialId,
          field: p.secretRef.field,
        };
      } else if (typeof p.value === 'string') {
        sanitized.value = p.value;
      }
      return sanitized;
    });
}

function sanitizeAuthConfig(authConfig: any): any {
  if (!authConfig || typeof authConfig !== 'object') return authConfig;
  const sanitized: any = {
    location: authConfig.location,
    keyName: authConfig.keyName,
    prefix: authConfig.prefix,
  };
  if (authConfig.secretRef?.credentialId && authConfig.secretRef?.field) {
    sanitized.secretRef = {
      credentialId: authConfig.secretRef.credentialId,
      field: authConfig.secretRef.field,
    };
  }
  return sanitized;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function extractForwardHeaders(
  req: Request,
  allowList: string[] | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const names = (allowList || [])
    .map((name) => name?.trim())
    .filter((name): name is string => Boolean(name));

  for (const name of names) {
    const rawName = name.toLowerCase();
    const value = firstHeaderValue(req.headers[rawName]);
    if (value && value.trim()) headers[name] = value;
  }
  return headers;
}

/**
 * Fetch and decode the secret data for a credential. Exported for reuse
 * by `internalMcpHealthRoutes.ts` (lazy re-registration on circuit-
 * breaker recovery).
 */
export async function resolveCredentialData(
  projectId: string,
  credentialId?: string,
): Promise<Record<string, string> | null> {
  if (!credentialId) return null;
  try {
    return await getCredentialService().readSecretData(projectId, credentialId);
  } catch (err: any) {
    logger.error(`[mcpServerRoutes] Failed to read credential ${credentialId}:`, err.message);
    return null;
  }
}

/**
 * Validates ``runtimeCredentialId`` when the catalog entry declares a
 * ``credentialMapping``. Returns an error message string when invalid, or null
 * when valid (or when the catalog entry has no ``credentialMapping``, in which
 * case ``runtimeCredentialId`` is ignored).
 */
async function validateRuntimeCredential(
  projectId: string,
  catalogEntry: { credentialMapping?: { expectedProvider: string } },
  runtimeCredentialId?: string,
): Promise<string | null> {
  if (!catalogEntry.credentialMapping) return null;
  if (!runtimeCredentialId) {
    return `runtimeCredentialId is required (expected provider: ${catalogEntry.credentialMapping.expectedProvider})`;
  }
  const cred = await getCredentialService().getById(projectId, runtimeCredentialId);
  if (!cred) {
    return `runtimeCredentialId ${runtimeCredentialId} not found in project`;
  }
  if (cred.provider !== catalogEntry.credentialMapping.expectedProvider) {
    return `runtimeCredentialId provider mismatch: credential.provider='${cred.provider}', expected='${catalogEntry.credentialMapping.expectedProvider}'`;
  }
  return null;
}

async function findServerByIdForProject(
  repo: Repository<MCPServer>,
  id: string,
  projectId: string,
): Promise<MCPServer | null> {
  return repo.findOne({
    where: [
      { id, projectId },
      { id, deploymentType: 'platform' as const },
    ],
  });
}

/** Project MCP rows plus shared platform MCPs (same shape as the list API). */
async function listMcpServersForProjectView(
  repo: Repository<MCPServer>,
  projectId: string,
): Promise<MCPServer[]> {
  const [projectServers, platformServers] = await Promise.all([
    repo.find({ where: { projectId } }),
    repo.find({ where: { deploymentType: 'platform' } }),
  ]);
  return [...platformServers, ...projectServers];
}

// ── List MCP Servers ──
router.get('/', validateProject, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(MCPServer);
    const items = await listMcpServersForProjectView(repo, projectId);

    const includeSummary = (req.query.include as string | undefined) !== 'dependentsSummary=false';
    if (!includeSummary || items.length === 0) {
      return res.json(items);
    }
    // Project-scoped servers contribute to dependents counts; platform
    // servers are shared and reuse their (server) projectId for lookup
    // when present.
    const projectIds = Array.from(new Set(items.map((s) => s.projectId).filter(Boolean)));
    const summary = new Map<string, { total: number; byKind: Record<string, number> }>();
    for (const pid of projectIds) {
      const ids = items.filter((s) => s.projectId === pid).map((s) => s.id);
      const part = await summaryForTargets('mcp_server', pid, ids);
      for (const [k, v] of part) summary.set(k, v);
    }
    res.json(items.map((s) => ({
      ...s,
      dependentsSummary: summary.get(s.id) ?? { total: 0, byKind: {} },
    })));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Validate managed catalog MCP config (without persisting) ──
router.post('/validate-managed-config', validateProject, validateConnectionRateLimiter, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId;
    const catalogId = req.body?.catalogId;
    if (!catalogId || typeof catalogId !== 'string') {
      return res.status(400).json({ success: false, message: 'catalogId is required', status: 'error' });
    }

    const result = await validateManagedMcpConfig(projectId, {
      catalogId,
      runtimeCredentialId: req.body?.runtimeCredentialId,
      managedConfig: req.body?.managedConfig,
    });

    const statusCode = result.success ? 200 : 400;
    return res.status(statusCode).json(result);
  } catch (e: any) {
    return res.status(400).json({
      success: false,
      message: e.message || 'Validation failed',
      status: 'error',
    });
  }
});

// ── Validate MCP connection (without persisting) ──
router.post('/validate-connection', validateProject, validateConnectionRateLimiter, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId;
    const transport = parseValidateTransport(req.body?.transport);
    if (!transport) {
      return res.status(400).json({ success: false, message: 'transport must be one of: http, sse, streamable-http' });
    }
    const validatedUrl = validatePublicHttpUrl(req.body?.url);
    if (!validatedUrl.ok) return res.status(400).json({ success: false, message: validatedUrl.message });

    const sanitizedRemoteBody = {
      deploymentType: 'remote' as const,
      transport,
      url: validatedUrl.value,
      authType: req.body?.authType,
      credentialId: req.body?.credentialId,
      authorizationUrl: req.body?.authorizationUrl,
      tokenUrl: req.body?.tokenUrl,
      timeout: req.body?.timeout,
      trust: req.body?.trust,
      allowedTools: req.body?.allowedTools,
      disallowedTools: req.body?.disallowedTools,
      staticHeaders: normalizeStaticHeaders(req.body.staticHeaders),
      queryParams: sanitizeConnectionParams(req.body.queryParams),
      headerParams: sanitizeConnectionParams(req.body.headerParams),
      authConfig: sanitizeAuthConfig(req.body.authConfig),
    };
    const gateway = getLLMGatewayClient();
    if (!gateway.isEnabled()) {
      return res.status(503).json({ success: false, message: 'Bifrost gateway not configured' });
    }

    const validationName = `validate_${projectId}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const serverConfig = await buildGatewayServerConfig(projectId, sanitizedRemoteBody);
    const created = await gateway.addMCPServer({
      server_name: validationName,
      alias: validationName,
      projectId,
      ...serverConfig,
    });

    let testResult = { success: false, message: 'Connection failed' };
    let toolsCount = 0;
    try {
      testResult = await gateway.testMCPConnection(validationName);
      if (testResult.success) {
        const tools = await gateway.listMCPTools(validationName);
        toolsCount = tools.length;
        if (toolsCount === 0) {
          testResult = {
            success: false,
            message: 'Connected but no tools discovered from MCP server',
          };
        }
      }
    } finally {
      await gateway.removeMCPServer(created.server_id, {
        projectId,
        mcpClientName: validationName,
      }).catch(() => {});
    }

    return res.json({
      success: !!testResult.success,
      message:
        testResult.message ||
        (testResult.success
          ? `Connected — ${toolsCount} tool(s) discovered`
          : 'Connection failed'),
      status: testResult.success ? 'connected' : 'error',
    });
  } catch (e: any) {
    return res.status(400).json({ success: false, message: e.message || 'Validation failed' });
  }
});

// ── Refresh MCP health status for project + platform servers ──
router.post('/refresh', validateProject, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(MCPServer);
    const servers = await listMcpServersForProjectView(repo, projectId);
    const gateway = getLLMGatewayClient();
    if (!gateway.isEnabled()) {
      return res.status(503).json({ error: 'Bifrost gateway not configured' });
    }

    let refreshed = 0;
    let failed = 0;
    let pending = 0;
    for (const server of servers) {
      // Servers without a gateway registration (e.g. managed MCPs whose pod is
      // still provisioning, or failed to start) cannot be probed via Bifrost.
      // Reflect their runtime state so the UI shows the real health instead of
      // a stale "Unknown", and count them so the result is meaningful.
      if (!server.llmproxyGatewayServerName) {
        if (server.runtimeStatus === 'failed') {
          await repo.update(server.id, { status: 'error' } as any);
          failed += 1;
        } else {
          pending += 1;
        }
        continue;
      }
      try {
        const result = await gateway.testMCPConnection(server.llmproxyGatewayServerName);
        await repo.update(server.id, {
          status: result.success ? 'connected' : 'error',
          syncStatus: server.syncStatus || 'synced',
        } as any);
        if (result.success) {
          refreshed += 1;
        } else {
          failed += 1;
        }
      } catch {
        await repo.update(server.id, { status: 'error' } as any);
        failed += 1;
      }
    }
    return res.json({ success: true, total: servers.length, refreshed, failed, pending });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

// ── Get MCP Server by ID ──
router.get('/:id', validateProject, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(MCPServer);
    const item = await findServerByIdForProject(repo, req.params.id, projectId);
    if (!item) return res.status(404).json({ error: 'MCP server not found' });
    res.json(item);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Create MCP Server ──
router.post('/', validateProject, createMCPServerValidator, async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(MCPServer);
    const deploymentType = req.body.deploymentType || 'remote';

    const exists = await repo.findOne({ where: { name: req.body.name, projectId } });
    if (exists) {
      return res.status(409).json({ error: 'MCP server with this name already exists in this project' });
    }

    // ── Managed deployment path ──
    if (deploymentType === 'managed') {
      const catalogEntry = getCatalogEntry(req.body.catalogId);
      if (!catalogEntry) {
        return res.status(400).json({ error: `Unknown catalog ID: ${req.body.catalogId}` });
      }
      if (catalogEntry.id === WEB_SEARCH_CATALOG_ID && !WEB_SEARCH_ENABLED) {
        return res.status(403).json({ error: 'web_search_mcp is disabled by rollout guard' });
      }
      if (catalogEntry.id === SEARXNG_WEB_SEARCH_CATALOG_ID && !WEB_SEARCH_ENABLED) {
        return res.status(403).json({ error: 'searxng_web_search_mcp is disabled by rollout guard' });
      }

      const runtimeCredErr = await validateRuntimeCredential(
        projectId, catalogEntry, req.body.runtimeCredentialId,
      );
      if (runtimeCredErr) {
        return res.status(400).json({ error: runtimeCredErr });
      }

      const k8sResourceName = buildK8sResourceName(projectId, req.body.name);
      const rawEnvOverrides: Record<string, string> = req.body.managedConfig?.envOverrides || {};
      const envOverrides = catalogEntry.id === WEB_SEARCH_CATALOG_ID
        ? normalizeWebSearchManagedConfig(rawEnvOverrides)
        : catalogEntry.id === SEARXNG_WEB_SEARCH_CATALOG_ID
          ? normalizeSearxngManagedConfig(rawEnvOverrides)
          : rawEnvOverrides;
      const { secretEnvVars, nonSecretEnvVars } = splitEnvVars(envOverrides, catalogEntry.envSchema);

      // Store only non-secret values in DB; mask secret values
      const dbEnvOverrides: Record<string, string> = { ...nonSecretEnvVars };
      for (const key of Object.keys(secretEnvVars)) {
        dbEnvOverrides[key] = '***';
      }

      const normalizedAllowedTools = catalogEntry.id === WEB_SEARCH_CATALOG_ID
        ? normalizeWebSearchAllowedTools(req.body.allowedTools || catalogEntry.defaultAllowedTools)
        : (req.body.allowedTools || catalogEntry.defaultAllowedTools);

      const server = repo.create({
        name: req.body.name,
        description: req.body.description,
        projectId,
        deploymentType: 'managed',
        catalogId: req.body.catalogId,
        runtimeCredentialId: catalogEntry.credentialMapping
          ? req.body.runtimeCredentialId
          : undefined,
        managedConfig: {
          resourcePreset: req.body.managedConfig?.resourcePreset || catalogEntry.resourcePreset,
          envOverrides: dbEnvOverrides,
          volumeSize: req.body.managedConfig?.volumeSize,
        },
        k8sResourceName,
        runtimeStatus: 'provisioning',
        syncStatus: 'pending',
        allowedTools: normalizedAllowedTools,
        disallowedTools: req.body.disallowedTools,
        extraHeaders: req.body.extraHeaders,
        trust: req.body.trust,
        timeout: catalogEntry.id === WEB_SEARCH_CATALOG_ID
          ? Number(envOverrides.TAVILY_TIMEOUT_MS || 10000)
          : catalogEntry.id === SEARXNG_WEB_SEARCH_CATALOG_ID
            ? Number(envOverrides.SEARXNG_TIMEOUT_MS || 10000)
          : req.body.timeout,
      });
      await repo.save(server);
      await applyForEntity(undefined, 'mcp_server', projectId, server);

      getMCPRuntimeManager().provisionAsync(
        server.id, projectId, server.name, k8sResourceName,
        catalogEntry, secretEnvVars, nonSecretEnvVars,
        server.runtimeCredentialId,
      );

      return res.status(201).json(server);
    }

    // ── Remote deployment path (existing flow) ──
    const sanitizedRemoteBody = {
      ...req.body,
      staticHeaders: normalizeStaticHeaders(req.body.staticHeaders),
      queryParams: sanitizeConnectionParams(req.body.queryParams),
      headerParams: sanitizeConnectionParams(req.body.headerParams),
      authConfig: sanitizeAuthConfig(req.body.authConfig),
    };
    const llmproxyGatewayServerName = buildLlmproxyGatewayServerName(projectId, req.body.name);
    const credentialData = await resolveCredentialData(projectId, req.body.credentialId);
    const serverConfig = await buildGatewayServerConfig(
      projectId,
      { ...sanitizedRemoteBody, transport: req.body.transport },
      credentialData,
    );

    const gateway = getLLMGatewayClient();
    let llmproxyGatewayServerId: string | undefined;

    if (gateway.isEnabled()) {
      try {
        const resp = await gateway.addMCPServer({
          server_name: llmproxyGatewayServerName,
          alias: req.body.name,
          projectId,
          ...serverConfig,
        });
        llmproxyGatewayServerId = resp.server_id;
      } catch (gatewayErr: any) {
        const msg = String(gatewayErr?.message || '');
        const isDuplicateName = msg.includes('already exists');
        if (!isDuplicateName) throw gatewayErr;
        // Reuse orphaned Bifrost MCP client with the same generated name.
        const existingGatewayServer = (await gateway.listMCPServers())
          .find((s) => s.server_name === llmproxyGatewayServerName);
        if (!existingGatewayServer?.server_id) {
          throw gatewayErr;
        }
        llmproxyGatewayServerId = existingGatewayServer.server_id;
      }

      // Hard validation gate: a server is "creatable" only if it connects and
      // exposes at least one tool via Bifrost.
      const testResult = await gateway.testMCPConnection(llmproxyGatewayServerName);
      if (!testResult.success) {
        if (llmproxyGatewayServerId) {
          await gateway.removeMCPServer(llmproxyGatewayServerId, {
            projectId,
            mcpClientName: llmproxyGatewayServerName,
          }).catch(() => {});
        }
        return res.status(400).json({
          error: `MCP validation failed: ${testResult.message || 'connection failed'}`,
        });
      }
      const tools = await gateway.listMCPTools(llmproxyGatewayServerName);
      if (!tools.length) {
        if (llmproxyGatewayServerId) {
          await gateway.removeMCPServer(llmproxyGatewayServerId, {
            projectId,
            mcpClientName: llmproxyGatewayServerName,
          }).catch(() => {});
        }
        return res.status(400).json({
          error: 'MCP validation failed: connected but no tools discovered',
        });
      }
    }

    try {
      const server = repo.create({
        ...sanitizedRemoteBody,
        projectId,
        deploymentType: 'remote',
        llmproxyGatewayServerId,
        llmproxyGatewayServerName,
        status: llmproxyGatewayServerId ? 'connected' : 'unknown',
        syncStatus: llmproxyGatewayServerId ? 'synced' : 'pending',
      });
      await repo.save(server);
      await applyForEntity(undefined, 'mcp_server', projectId, server);
      res.status(201).json(server);
    } catch (dbErr: any) {
      if (llmproxyGatewayServerId) {
        await gateway.removeMCPServer(llmproxyGatewayServerId).catch(() => {});
      }
      throw dbErr;
    }
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── Update MCP Server ──
router.put('/:id', validateProject, updateMCPServerValidator, async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(MCPServer);

    const existing = await findServerByIdForProject(repo, req.params.id, projectId);
    if (!existing) return res.status(404).json({ error: 'MCP server not found' });
    if (existing.deploymentType === 'platform') {
      return res.status(403).json({ error: 'Platform MCP servers cannot be modified through project routes' });
    }

    if (req.body.name && req.body.name !== existing.name) {
      const dupe = await repo.findOne({
        where: { name: req.body.name, projectId, id: Not(req.params.id) },
      });
      if (dupe) {
        return res.status(409).json({ error: 'MCP server with this name already exists in this project' });
      }
    }

    // ── Managed update path ──
    // Only whitelisted fields are picked into updateFields below;
    // any extraneous fields the client sends (transport, url, etc.) are silently ignored.
    if (existing.deploymentType === 'managed') {
      const updateFields: Partial<MCPServer> = {};
      if (req.body.name) updateFields.name = req.body.name;
      if (req.body.description !== undefined) updateFields.description = req.body.description;
      if (req.body.disallowedTools !== undefined) updateFields.disallowedTools = req.body.disallowedTools;
      if (req.body.extraHeaders !== undefined) updateFields.extraHeaders = req.body.extraHeaders;
      if (req.body.trust !== undefined) updateFields.trust = req.body.trust;

      if (req.body.runtimeCredentialId !== undefined) {
        const catalogForCred = getCatalogEntry(existing.catalogId!);
        if (catalogForCred?.credentialMapping) {
          const runtimeCredErr = await validateRuntimeCredential(
            projectId, catalogForCred, req.body.runtimeCredentialId,
          );
          if (runtimeCredErr) {
            return res.status(400).json({ error: runtimeCredErr });
          }
          updateFields.runtimeCredentialId = req.body.runtimeCredentialId;
        }
        // Catalog entries without credentialMapping silently ignore the field
        // (matches behavior for other managed-only fields).
      }

      if (req.body.allowedTools !== undefined) {
        updateFields.allowedTools = existing.catalogId === WEB_SEARCH_CATALOG_ID
          ? normalizeWebSearchAllowedTools(req.body.allowedTools)
          : req.body.allowedTools;
      }

      if (req.body.managedConfig) {
        const catalogEntry = getCatalogEntry(existing.catalogId!);
        if (!catalogEntry) {
          return res.status(400).json({ error: 'Catalog entry not found for this server' });
        }

        const rawEnvOverrides: Record<string, string> = req.body.managedConfig.envOverrides || {};
        const envOverrides = catalogEntry.id === WEB_SEARCH_CATALOG_ID
          ? normalizeWebSearchManagedConfig(rawEnvOverrides)
          : catalogEntry.id === SEARXNG_WEB_SEARCH_CATALOG_ID
            ? normalizeSearxngManagedConfig(rawEnvOverrides)
          : rawEnvOverrides;
        const { secretEnvVars, nonSecretEnvVars } = splitEnvVars(envOverrides, catalogEntry.envSchema);

        // Preserve unchanged secrets (value === '***')
        const actualSecrets: Record<string, string> = {};
        for (const [key, value] of Object.entries(secretEnvVars)) {
          if (value !== '***') {
            actualSecrets[key] = value;
          }
        }

        const dbEnvOverrides: Record<string, string> = { ...nonSecretEnvVars };
        for (const key of Object.keys(secretEnvVars)) {
          dbEnvOverrides[key] = '***';
        }

        updateFields.managedConfig = {
          resourcePreset: req.body.managedConfig.resourcePreset || existing.managedConfig?.resourcePreset,
          envOverrides: dbEnvOverrides,
          volumeSize: req.body.managedConfig.volumeSize || existing.managedConfig?.volumeSize,
        };

        if (Object.keys(actualSecrets).length > 0 || Object.keys(nonSecretEnvVars).length > 0) {
          await getMCPRuntimeManager().patchConfig(existing, catalogEntry, actualSecrets, nonSecretEnvVars);
        }
        if (catalogEntry.id === WEB_SEARCH_CATALOG_ID) {
          updateFields.timeout = Number(envOverrides.TAVILY_TIMEOUT_MS || 10000);
        } else if (catalogEntry.id === SEARXNG_WEB_SEARCH_CATALOG_ID) {
          updateFields.timeout = Number(envOverrides.SEARXNG_TIMEOUT_MS || 10000);
        }
      }

      await repo.update(req.params.id, updateFields as any);

      // Sync tool filters with the Bifrost gateway if synced
      const gateway = getLLMGatewayClient();
      if (gateway.isEnabled() && existing.llmproxyGatewayServerId && existing.syncStatus === 'synced') {
        try {
          const merged = { ...existing, ...updateFields };
          await gateway.editMCPServer({
            server_id: existing.llmproxyGatewayServerId,
            url: existing.url,
            transport: 'http',
            auth_type: 'none',
            allowed_tools: merged.allowedTools || undefined,
            blocked_tools: merged.disallowedTools || undefined,
            ...(Array.isArray(merged.extraHeaders) ? { extra_headers: merged.extraHeaders } : {}),
          });
        } catch (gatewayErr: any) {
          logger.error(`[mcpServerRoutes] Bifrost gateway edit for managed server failed:`, gatewayErr.message);
        }
      }

      const updated = await repo.findOne({ where: { id: req.params.id, projectId } });
      if (updated) {
        await applyForEntity(undefined, 'mcp_server', projectId, updated);
      }
      return res.json(updated);
    }

    // ── Remote update path ──
    const remoteAllowedFields = [
      'name', 'description', 'transport', 'url', 'command', 'args', 'env',
      'authType', 'credentialId', 'authorizationUrl', 'tokenUrl',
      'staticHeaders', 'queryParams', 'headerParams', 'authConfig',
      'extraHeaders', 'allowedTools', 'disallowedTools',
      'specPath', 'timeout', 'trust', 'serverInstructions',
    ] as const;
    const remoteUpdateFields: Partial<MCPServer> = {};
    for (const field of remoteAllowedFields) {
      if (req.body[field] !== undefined) {
        (remoteUpdateFields as any)[field] = req.body[field];
      }
    }
    if (remoteUpdateFields.queryParams !== undefined) {
      remoteUpdateFields.queryParams = sanitizeConnectionParams(remoteUpdateFields.queryParams as MCPConnectionParam[]);
    }
    if (remoteUpdateFields.headerParams !== undefined) {
      remoteUpdateFields.headerParams = sanitizeConnectionParams(remoteUpdateFields.headerParams as MCPConnectionParam[]);
    }
    if (remoteUpdateFields.authConfig !== undefined) {
      (remoteUpdateFields as any).authConfig = sanitizeAuthConfig(remoteUpdateFields.authConfig);
    }
    if (req.body.staticHeaders !== undefined) {
      remoteUpdateFields.staticHeaders = normalizeStaticHeaders(req.body.staticHeaders);
    }

    const gateway = getLLMGatewayClient();
    const merged = { ...existing, ...remoteUpdateFields };
    const newLlmproxyGatewayServerName = buildLlmproxyGatewayServerName(projectId, merged.name);
    const credentialData = await resolveCredentialData(projectId, merged.credentialId);
    const serverConfig = await buildGatewayServerConfig(projectId, merged, credentialData);

    let newSyncStatus = existing.syncStatus;

    if (gateway.isEnabled()) {
      if (existing.llmproxyGatewayServerId) {
        try {
          await gateway.editMCPServer({
            server_id: existing.llmproxyGatewayServerId,
            server_name: newLlmproxyGatewayServerName,
            alias: merged.name,
            ...serverConfig,
          });
          newSyncStatus = 'synced';
        } catch (gatewayErr: any) {
          logger.error(`[mcpServerRoutes] Bifrost gateway edit failed for ${existing.llmproxyGatewayServerId}, rolling back DB:`, gatewayErr.message);
          newSyncStatus = 'error';
        }
      } else {
        try {
          const resp = await gateway.addMCPServer({
            server_name: newLlmproxyGatewayServerName,
            alias: merged.name,
            projectId,
            ...serverConfig,
          });
          await repo.update(req.params.id, {
            ...remoteUpdateFields,
            llmproxyGatewayServerId: resp.server_id,
            llmproxyGatewayServerName: newLlmproxyGatewayServerName,
            syncStatus: 'synced',
          });
          const updated = await repo.findOne({ where: { id: req.params.id, projectId } });
          if (updated) {
            await applyForEntity(undefined, 'mcp_server', projectId, updated);
          }
          return res.json(updated);
        } catch (gatewayErr: any) {
          logger.error(`[mcpServerRoutes] Bifrost gateway add on update failed:`, gatewayErr.message);
          newSyncStatus = 'error';
        }
      }
    }

    await repo.update(req.params.id, {
      ...remoteUpdateFields,
      llmproxyGatewayServerName: newLlmproxyGatewayServerName,
      syncStatus: newSyncStatus,
    });

    const updated = await repo.findOne({ where: { id: req.params.id, projectId } });
    if (updated) {
      await applyForEntity(undefined, 'mcp_server', projectId, updated);
    }
    res.json(updated);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── Delete MCP Server ──
router.delete('/:id', validateProject, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(MCPServer);

    const existing = await findServerByIdForProject(repo, req.params.id, projectId);
    if (!existing) return res.status(404).json({ error: 'MCP server not found' });
    if (existing.deploymentType === 'platform') {
      return res.status(403).json({ error: 'Platform MCP servers cannot be deleted through project routes' });
    }

    if (await hasDependents('mcp_server', projectId, req.params.id)) {
      const page = await listDependents('mcp_server', projectId, req.params.id, { limit: 50 });
      return res.status(409).json({
        error:
          'Cannot delete this MCP server because it is still in use. Update or remove those references, then try again.',
        code: 'HAS_DEPENDENTS',
        dependents: page,
      });
    }

    const gateway = getLLMGatewayClient();
    if (gateway.isEnabled()) {
      const candidateNames = Array.from(
        new Set(
          [
            existing.llmproxyGatewayServerName,
            buildLlmproxyGatewayServerName(projectId, existing.name),
          ].filter((name): name is string => Boolean(name && name.trim())),
        ),
      );

      // Primary delete path (by stored gateway id).
      if (existing.llmproxyGatewayServerId) {
        await gateway.removeMCPServer(existing.llmproxyGatewayServerId, {
          projectId,
          mcpClientName: existing.llmproxyGatewayServerName || candidateNames[0],
        });
      }

      // Strong-consistency sweep: remove any stale Bifrost clients that still
      // exist under current/legacy generated names for this MCP server.
      if (candidateNames.length > 0) {
        const listed = await gateway.listMCPServers();
        const staleMatches = listed.filter((s) => candidateNames.includes(s.server_name));
        for (const stale of staleMatches) {
          await gateway.removeMCPServer(stale.server_id, {
            projectId,
            mcpClientName: stale.server_name,
          });
        }

        const remaining = (await gateway.listMCPServers())
          .filter((s) => candidateNames.includes(s.server_name));
        if (remaining.length > 0) {
          return res.status(502).json({
            error: 'Failed to delete MCP server from Bifrost gateway',
            remainingGatewayClients: remaining.map((r) => r.server_name),
          });
        }
      }
    }

    if (existing.deploymentType === 'managed') {
      await repo.update(req.params.id, { runtimeStatus: 'deleting' });
      try {
        await getMCPRuntimeManager().deprovision(existing);
      } catch (deprovErr: any) {
        logger.error(`[mcpServerRoutes] Deprovision failed for ${existing.id}:`, deprovErr.message);
      }
    }

    await removeForSource(undefined, 'mcp_server', projectId, req.params.id);
    await repo.delete(req.params.id);
    res.json({ deleted: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/dependents', validateProject, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(MCPServer);
    const exists = await findServerByIdForProject(repo, req.params.id, projectId);
    if (!exists) return res.status(404).json({ error: 'MCP server not found' });

    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const cursor = (req.query.cursor as string | undefined) || undefined;
    const kind = (req.query.kind as string | undefined) || undefined;
    // Use the server's actual project (handles platform servers reusing
    // a different projectId) for the edge lookup.
    const lookupProjectId = exists.projectId;
    const page = await listDependents('mcp_server', lookupProjectId, req.params.id, { limit, cursor, kind });
    res.json(page);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Test Connection ──
router.post('/:id/test-connection', validateProject, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(MCPServer);
    const server = await findServerByIdForProject(repo, req.params.id, projectId);
    if (!server) return res.status(404).json({ error: 'MCP server not found' });

    const gateway = getLLMGatewayClient();
    if (!gateway.isEnabled()) {
      return res.status(503).json({ error: 'Bifrost gateway not configured' });
    }
    if (!server.llmproxyGatewayServerName) {
      return res.status(400).json({ error: 'MCP server not synced to Bifrost gateway' });
    }

    // Re-register with the gateway if server was suspended by the circuit breaker
    if (server.syncStatus === 'suspended') {
      logger.info(`[mcpServerRoutes] test-connection: re-registering suspended server id=${server.id} name=${server.llmproxyGatewayServerName}`);
      const credentialData = await resolveCredentialData(projectId, server.credentialId);
      const serverConfig = await buildGatewayServerConfig(projectId, server, credentialData);
      const llmproxyGatewayServerName = server.llmproxyGatewayServerName;
      try {
        const resp = await gateway.addMCPServer({
          server_name: llmproxyGatewayServerName,
          alias: server.name,
          projectId,
          ...serverConfig,
        });
        await repo.update(server.id, {
          llmproxyGatewayServerId: resp.server_id,
          syncStatus: 'synced',
        } as any);
        logger.info(`[mcpServerRoutes] test-connection: re-registered server id=${server.id} gatewayServerId=${resp.server_id}`);
      } catch (regErr: any) {
        logger.error(`[mcpServerRoutes] test-connection: re-registration failed for id=${server.id}: ${regErr.message}`);
        return res.json({ success: false, message: `Re-registration failed: ${regErr.message}`, status: 'error' });
      }
    }

    const result = await gateway.testMCPConnection(server.llmproxyGatewayServerName);

    const newStatus = result.success ? 'connected' : 'error';
    const updateFields: Partial<MCPServer> = { status: newStatus } as any;
    if (result.success) {
      (updateFields as any).consecutiveFailures = 0;
      if (result.serverInstructions) {
        (updateFields as any).serverInstructions = result.serverInstructions;
      }
    }
    await repo.update(server.id, updateFields as any);

    res.json({ ...result, status: newStatus });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── List Tools from MCP Server ──
router.get('/:id/tools', validateProject, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(MCPServer);
    const server = await findServerByIdForProject(repo, req.params.id, projectId);
    if (!server) return res.status(404).json({ error: 'MCP server not found' });

    const gateway = getLLMGatewayClient();
    if (!gateway.isEnabled()) {
      return res.status(503).json({ error: 'Bifrost gateway not configured' });
    }
    if (!server.llmproxyGatewayServerName) {
      return res.status(400).json({ error: 'MCP server not synced to Bifrost gateway' });
    }

    logger.info(`[mcpServerRoutes] GET /:id/tools — server=${server.name} gatewayName=${server.llmproxyGatewayServerName}`);
    const tools = await gateway.listMCPTools(server.llmproxyGatewayServerName);
    logger.info(`[mcpServerRoutes] GET /:id/tools — returned ${tools.length} tool(s)`);
    res.json(tools);
  } catch (e: any) {
    logger.error(`[mcpServerRoutes] GET /:id/tools — error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── Call Tool on MCP Server ──
router.post('/:id/tools/call', validateProject, async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(MCPServer);
    const server = await findServerByIdForProject(repo, req.params.id, projectId);
    if (!server) return res.status(404).json({ error: 'MCP server not found' });

    const { toolName, arguments: toolArgs = {} } = req.body;
    if (!toolName || typeof toolName !== 'string') {
      return res.status(400).json({ error: 'toolName (string) is required in body' });
    }

    if (server.allowedTools?.length && !server.allowedTools.includes(toolName)) {
      return res.status(403).json({ error: `Tool '${toolName}' is not in the allowed tools list` });
    }
    if (server.disallowedTools?.length && server.disallowedTools.includes(toolName)) {
      return res.status(403).json({ error: `Tool '${toolName}' is blocked by the disallowed tools list` });
    }

    const gateway = getLLMGatewayClient();
    if (!gateway.isEnabled()) {
      return res.status(503).json({ error: 'Bifrost gateway not configured' });
    }
    if (!server.llmproxyGatewayServerName) {
      return res.status(400).json({ error: 'MCP server not synced to Bifrost gateway' });
    }

    logger.info(`[mcpServerRoutes] POST /:id/tools/call — server=${server.name} tool=${toolName} gatewayName=${server.llmproxyGatewayServerName} args=${JSON.stringify(toolArgs)}`);
    const forwardHeaders = extractForwardHeaders(req, server.extraHeaders);
    const result = await gateway.callMCPTool(
      server.llmproxyGatewayServerName,
      toolName,
      toolArgs,
      {
        timeoutMs: server.timeout,
        forwardHeaders,
      },
    );
    const elapsedMs = Date.now() - startedAt;
    logger.info(
      `[mcpServerRoutes] POST /:id/tools/call — completed tool=${toolName} ` +
      `elapsed_ms=${elapsedMs} project=${projectId} server_id=${server.id}`,
    );
    res.json(result);
  } catch (e: any) {
    const elapsedMs = Date.now() - startedAt;
    logger.error(
      `[mcpServerRoutes] POST /:id/tools/call — error: ${e.message} ` +
      `elapsed_ms=${elapsedMs} project=${req.params.projectId} server_id=${req.params.id}`,
    );
    res.status(500).json({ error: e.message });
  }
});

// ── History ──
router.get('/:id/history', validateProject, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId;
    const mcpRepo = AppDataSource.getRepository(MCPServer);
    const server = await findServerByIdForProject(mcpRepo, req.params.id, projectId);
    if (!server) return res.status(404).json({ error: 'MCP server not found' });

    const histRepo = AppDataSource.getRepository(MCPServerHistory);
    const history = await histRepo.find({
      where: { entityId: req.params.id },
      order: { version: 'DESC' },
    });
    if (!history.length) return res.status(404).json({ error: 'No history found' });
    res.json(history);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Runtime Status (for managed servers) ──
router.get('/:id/runtime-status', validateProject, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(MCPServer);
    const server = await findServerByIdForProject(repo, req.params.id, projectId);
    if (!server) return res.status(404).json({ error: 'MCP server not found' });
    if (server.deploymentType !== 'managed') {
      return res.status(400).json({ error: 'Runtime status is only available for managed MCP servers' });
    }

    const status = await getMCPRuntimeManager().getStatus(server);
    res.json(status);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Restore Version ──
router.post('/:id/restore-version', validateProject, async (req: Request, res: Response) => {
  const { version } = req.body;
  if (!version || typeof version !== 'number') {
    return res.status(400).json({ error: 'version (number) is required in body' });
  }
  try {
    const projectId = req.params.projectId;
    const histRepo = AppDataSource.getRepository(MCPServerHistory);
    const mcpRepo = AppDataSource.getRepository(MCPServer);

    const existing = await findServerByIdForProject(mcpRepo, req.params.id, projectId);
    if (!existing) return res.status(404).json({ error: 'MCP server not found' });
    if (existing.deploymentType === 'platform') {
      return res.status(403).json({ error: 'Platform MCP servers cannot be modified through project routes' });
    }

    if (existing.deploymentType === 'managed') {
      return res.status(400).json({ error: 'Version restore not supported for managed MCP servers' });
    }

    const history = await histRepo.findOne({
      where: { entityId: req.params.id, version },
    });
    if (!history) return res.status(404).json({ error: 'Version not found in history' });

    const { data } = history;
    // Strip legacy and current gateway-binding fields from the restored snapshot;
    // these are managed by the gateway-sync block below.
    const {
      id,
      createdAt,
      updatedAt,
      litellmServerId: _legacyLiteLLMServerId,
      litellmServerName: _legacyLiteLLMServerName,
      llmproxyGatewayServerId: _llmproxyGatewayServerId,
      llmproxyGatewayServerName: _llmproxyGatewayServerName,
      syncStatus,
      ...restoreData
    } = data;

    await mcpRepo.update(req.params.id, restoreData);

    const gateway = getLLMGatewayClient();
    if (gateway.isEnabled() && existing.llmproxyGatewayServerId) {
      try {
        const merged = { ...existing, ...restoreData };
        const credentialData = await resolveCredentialData(projectId, merged.credentialId);
        const serverConfig = await buildGatewayServerConfig(projectId, merged, credentialData);
        const newLlmproxyGatewayServerName = buildLlmproxyGatewayServerName(projectId, merged.name);
        await gateway.editMCPServer({
          server_id: existing.llmproxyGatewayServerId,
          server_name: newLlmproxyGatewayServerName,
          alias: merged.name,
          ...serverConfig,
        });
        await mcpRepo.update(req.params.id, { llmproxyGatewayServerName: newLlmproxyGatewayServerName, syncStatus: 'synced' });
      } catch (syncErr: any) {
        logger.error(`[mcpServerRoutes] Failed to sync restored version to Bifrost gateway:`, syncErr.message);
        await mcpRepo.update(req.params.id, { syncStatus: 'error' });
      }
    }

    const updated = await mcpRepo.findOne({ where: { id: req.params.id, projectId } });
    if (!updated) return res.status(404).json({ error: 'MCP server not found' });
    res.json({ restored: true, data: updated });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
