/**
 * One Bifrost governance team + virtual key per AgentStudio project.
 * Models (routing rules) and MCP clients (VK mcp_configs) are scoped to that team.
 */
import { AxiosInstance } from 'axios';
import { AppDataSource } from '../../db/postgres';
import { MCPServer } from '../../models/MCPServer';
import { Model } from '../../models/Model';
import { Project } from '../../models/Project';
import {
  isPlatformMcpAutoAttachable,
  readPlatformMcpAutoAttachFlags,
} from '../../catalog/platformMcpDefaults';
import { getK8sSecretService } from '../K8sSecretService';
import {
  safeConsoleError,
  safeConsoleLog,
  safeConsoleWarn,
  safeLog,
} from '../../utils/safeStrings';
import { ILLMGatewayClient } from '../LLMGatewayClient';
import { getCredentialService } from '../CredentialService';
import {
  fetchBifrostMcpClients,
  parseBifrostMcpListEntry,
} from './bifrostMcpOps';
import {
  deleteProviderKeyById,
  isPlatformTeiProvider,
  listGatewayProviders,
  listProviderKeys,
  mergeBuiltinVirtualKeyAllowedModels,
  removeProviderModelFromKey,
} from './bifrostProviderOps';
import {
  createBifrostClient,
  createModelConfig,
  createTeam,
  createVirtualKey,
  deleteModelConfig,
  deleteTeam,
  deleteVirtualKey,
  getTeam,
  getVirtualKey,
  listModelConfigs,
  listTeams,
  listVirtualKeys,
  listVirtualKeysArray,
  promoteSecondaryVirtualKey,
  rotateVirtualKey,
  updateModelConfig,
  updateVirtualKey,
} from './bifrostOps';

export interface ProjectBifrostGateway {
  teamId: string;
  teamName: string;
  virtualKeyId: string;
  virtualKeyName: string;
  /**
   * True while Bifrost dual-credential rotation is active (between
   * `POST .../rotate` and `POST .../promote-secondary`). Cleared on complete.
   */
  vkRotationPending?: boolean;
  /**
   * @deprecated Legacy create-and-delete rotation stored the old VK id here.
   * Still honored on gateway-rotate-complete when `vkRotationPending` is absent.
   */
  pendingRotationOldVirtualKeyId?: string;
  /**
   * @deprecated The VK bearer token MUST NOT be stored on this metadata
   * blob — it is secret-grade material and belongs only in (a) Bifrost's
   * own `config_store` and (b) the K8s Secret `as-proj-{projectId}-vk`.
   * Field is retained on the interface only to allow type-safe reads of
   * pre-migration rows during deserialisation; new writes deliberately
   * omit it and the startup migration `scrubProjectMetadataVirtualKeyToken`
   * removes any value left from prior writes. Will be dropped from the
   * interface entirely once all clusters have run the migration.
   */
  virtualKeyToken?: string;
}

export function projectTeamName(projectId: string): string {
  return `as-proj-${projectId}`;
}

export function projectVirtualKeyName(projectId: string): string {
  return `as-proj-${projectId}-vk`;
}

/**
 * K8s Secret name that holds this project's Bifrost virtual-key bearer token.
 * Mirrors the Bifrost VK name for easy operator correlation. Lives in the
 * shared application namespace alongside credential secrets and is keyed
 * under `virtual_key_token`.
 */
export function projectVirtualKeySecretName(projectId: string): string {
  return projectVirtualKeyName(projectId);
}

const VK_TOKEN_SECRET_KEY = 'virtual_key_token';

type WriteProjectVkSecretOptions = {
  /**
   * When true (VK rotation), K8s write failure fails the operation so Temporal
   * can retry. When false (ensureProjectGateway), failures are logged only.
   */
  required?: boolean;
};

/**
 * Persist the Bifrost virtual-key token for a project into a K8s Secret
 * `as-proj-{projectId}-vk` / key `virtual_key_token`. Idempotent create-or-update.
 */
async function writeProjectVirtualKeyTokenSecret(
  projectId: string,
  token: string,
  options?: WriteProjectVkSecretOptions,
): Promise<void> {
  const required = options?.required === true;
  if (!token) {
    if (required) {
      throw new Error(
        `Cannot write empty VK token to K8s Secret for project ${projectId}`,
      );
    }
    return;
  }
  const k8s = getK8sSecretService();
  const secretName = projectVirtualKeySecretName(projectId);
  const data = { [VK_TOKEN_SECRET_KEY]: token };
  let persisted = false;
  let lastErr: unknown;

  try {
    await k8s.createSecret(projectId, secretName, data);
    safeConsoleLog('[bifrostProjectGovernance] Wrote VK token to K8s Secret', secretName);
    persisted = true;
  } catch (err: any) {
    lastErr = err;
    const code = err?.code ?? err?.response?.statusCode ?? err?.statusCode;
    if (code !== 409 && code !== 'AlreadyExists') {
      safeConsoleWarn(
        '[bifrostProjectGovernance] createSecret failed',
        secretName,
        code,
        err?.message || err,
      );
    }
  }

  if (!persisted) {
    try {
      await k8s.updateSecret(projectId, secretName, data);
      safeConsoleLog(
        '[bifrostProjectGovernance] Updated VK token in K8s Secret',
        secretName,
      );
      persisted = true;
    } catch (err: any) {
      lastErr = err;
      if (required) {
        throw new Error(
          `[bifrostProjectGovernance] Failed to persist VK token Secret ${safeLog(secretName)}: ${safeLog(err?.message || err)}`,
        );
      }
      safeConsoleError(
        '[bifrostProjectGovernance] Failed to persist VK token Secret',
        secretName,
        err?.message || err,
      );
    }
  }

  if (required && !persisted) {
    const detail =
      lastErr instanceof Error
        ? lastErr.message
        : String(lastErr ?? 'unknown');
    throw new Error(
      `Failed to write VK token to K8s Secret ${safeLog(secretName)} for project ${safeLog(projectId)}: ${safeLog(detail)}`,
    );
  }
}

/**
 * Read the project's Bifrost VK bearer token from the K8s Secret
 * `as-proj-{projectId}-vk` (sole source). Returns ``undefined`` when
 * the Secret is missing or unreadable; callers (`llmproxy_gateway_api_key_for_model` in
 * agent-service) surface this as a loud ``MissingProjectVirtualKeyError``
 * rather than silently degrading.
 *
 * SECURITY: this function deliberately does NOT fall back to any
 * config-service-side store. The bearer token is secret-grade material
 * and must live only in (a) Bifrost's own `config_store` and (b) the
 * K8s Secret here. An earlier revision mirrored the token to
 * `projects.metadata._gateway.virtualKeyToken` as a fallback; that
 * write path is gone and any pre-migration values are scrubbed at
 * startup by `scrubProjectMetadataVirtualKeyToken` in `db/postgres.ts`.
 */
export async function readProjectVirtualKeyToken(
  projectId: string,
): Promise<string | undefined> {
  const k8s = getK8sSecretService();
  try {
    const data = await k8s.readSecret(projectVirtualKeySecretName(projectId));
    const token = data?.[VK_TOKEN_SECRET_KEY];
    if (token) return token;
  } catch (err: any) {
    const code = err?.code ?? err?.response?.statusCode ?? err?.statusCode;
    if (code !== 404 && code !== 'NotFound') {
      console.warn(
        `[bifrostProjectGovernance] readSecret for project ${safeLog(projectId)} failed (code=${safeLog(code)}): ${safeLog(err?.message || err)}`,
      );
    }
  }
  return undefined;
}

/**
 * Delete the K8s Secret that holds the VK token. Called on project deletion.
 * Swallows 404 so it's safe to invoke even when the project was created
 * before the Secret existed (token was metadata-only).
 */
export async function deleteProjectVirtualKeyTokenSecret(
  projectId: string,
): Promise<void> {
  const k8s = getK8sSecretService();
  try {
    await k8s.deleteSecret(projectVirtualKeySecretName(projectId));
  } catch (err: any) {
    const code = err?.code ?? err?.response?.statusCode ?? err?.statusCode;
    if (code === 404 || code === 'NotFound') return;
    throw err;
  }
}

function parseTeamId(team: Record<string, unknown>): string | undefined {
  const id = team.id ?? team.team_id;
  return id != null ? String(id) : undefined;
}

/**
 * Bifrost's `PUT /virtual-keys/:id` is a full replace, not a merge: any field
 * omitted from the body is reset (notably `team_id`, `mcp_configs`,
 * `provider_configs`). This helper fetches the current VK and PUTs the merged
 * payload so partial updates don't drop sibling fields.
 */
/**
 * Bifrost v1.5's `PUT /virtual-keys/:id` validates the WRITE shape, which
 * differs from the READ shape it returns on GET:
 *  - provider_configs: GET embeds full key objects under `keys`; PUT wants
 *    `key_ids: string[]` (mirrors {@link assignModelToProjectVirtualKey}).
 *  - mcp_configs: GET embeds the full client under `mcp_client` (no top-level
 *    `mcp_client_name`); PUT wants `mcp_client_name`. Re-sending the GET shape
 *    makes every entry collapse to an empty name → 400 "duplicate
 *    mcp_client_name". Entries that already exist on the VK must also carry
 *    their `id` + `mcp_client_id` so Bifrost treats them as references instead
 *    of trying to re-create the association → 400 "a record with this mcpclient
 *    already exists".
 */
export function toVkProviderConfigsWriteShape(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<Record<string, unknown>>).map((entry) => {
    const next = { ...entry };
    const ids: string[] = [];
    for (const v of (Array.isArray(next.key_ids) ? next.key_ids : []) as unknown[]) {
      if (typeof v === 'string' && v) ids.push(v);
    }
    for (const v of (Array.isArray(next.keys) ? next.keys : []) as unknown[]) {
      if (typeof v === 'string' && v) ids.push(v);
      else if (v && typeof v === 'object') {
        const id = (v as { key_id?: string }).key_id;
        if (typeof id === 'string' && id) ids.push(id);
      }
    }
    delete next.keys;
    const uniq = Array.from(new Set(ids));
    if (uniq.length) next.key_ids = uniq;
    return next;
  });
}

export function toVkMcpConfigsWriteShape(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    const mcpClient = entry.mcp_client as { id?: unknown; name?: string } | undefined;
    const name =
      (entry.mcp_client_name as string | undefined) ||
      mcpClient?.name ||
      (entry.name as string | undefined);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const tools = entry.tools_to_execute;
    const writeEntry: Record<string, unknown> = {
      mcp_client_name: name,
      tools_to_execute: Array.isArray(tools) && tools.length ? tools : ['*'],
    };
    if (entry.id !== undefined && entry.id !== null) writeEntry.id = entry.id;
    const clientId = entry.mcp_client_id ?? mcpClient?.id;
    if (clientId !== undefined && clientId !== null) writeEntry.mcp_client_id = clientId;
    out.push(writeEntry);
  }
  return out;
}

/**
 * Extract the owning AgentStudio project id from a project virtual-key name.
 * VK names follow {@link projectVirtualKeyName} (`as-proj-<projectId>-vk`),
 * with an optional rotation suffix (`-r<n>`). Returns `undefined` for names
 * that don't match the project-VK shape.
 */
export function projectIdFromVkName(
  vkName: string | undefined | null,
): string | undefined {
  if (!vkName) return undefined;
  const m = /^as-proj-(.+?)-vk(?:-r\d+)?$/.exec(vkName);
  return m ? m[1] : undefined;
}

/**
 * Strip MCP clients that belong to a DIFFERENT project out of a VK's
 * `mcp_configs`.
 *
 * Bifrost MCP clients for a project are named `<projectId>_<server>` (see
 * config-service `buildLlmproxyGatewayServerName`). A project's virtual key
 * must only ever expose (a) its own `<ownerProjectId>_*` clients and (b)
 * non-project / platform clients that carry no project prefix (e.g.
 * `analytics_datasets_mcp`). A client whose name is project-scoped to a
 * *different* project is a cross-project leak: an agent authenticating with
 * this VK would be able to reach that other project's MCP tools.
 *
 * This is the guard that stops the GET→normalize→PUT cycle in
 * {@link mergePutVirtualKey} from perpetually re-persisting any cross-project
 * client that has leaked into the VK, and self-heals an already-contaminated
 * VK on its next write.
 */
export function filterMcpConfigsToProject(
  configs: Array<Record<string, unknown>>,
  ownerProjectId: string | undefined,
): Array<Record<string, unknown>> {
  if (!ownerProjectId) return configs;
  const ownPrefix = `${ownerProjectId}_`;
  // Recognises a name shaped like a project-scoped client (`proj` + generated
  // token + `_`). Platform/shared clients (no project prefix) never match and
  // are preserved.
  const projectScoped = /^proj[a-z0-9]{6,}_/i;
  const dropped: string[] = [];
  const kept = configs.filter((c) => {
    const name = (c.mcp_client_name as string | undefined) || '';
    if (!name) return true;
    if (name.startsWith(ownPrefix)) return true; // own project's client
    if (projectScoped.test(name)) {
      dropped.push(name);
      return false; // another project's client — never expose cross-project
    }
    return true; // platform / shared client (no project prefix)
  });
  if (dropped.length) {
    safeConsoleWarn(
      `[bifrostProjectGovernance] Dropped ${dropped.length} cross-project mcp_configs from VK for project ${safeLog(ownerProjectId)}: ${safeLog(dropped.join(', '))}`,
    );
  }
  return kept;
}

/** Prefix for project-scoped Bifrost MCP client names (`<projectId>_<server>`). */
export function projectMcpClientPrefix(projectId: string): string {
  return `${projectId}_`;
}

/** True when a VK name belongs to this project (includes rotated `-r<n>` suffixes). */
export function projectVkNameMatches(
  vkName: string | undefined | null,
  projectId: string,
): boolean {
  if (!vkName || !projectId) return false;
  const escaped = projectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^as-proj-${escaped}-vk(?:-r\\d+)?$`).test(vkName);
}

async function readCredentialApiKey(
  projectId: string,
  credentialId: string,
): Promise<string | undefined> {
  try {
    const secret = await getCredentialService().readSecretData(projectId, credentialId);
    return secret?.api_key;
  } catch {
    return undefined;
  }
}

/**
 * Belt-and-suspenders Bifrost cleanup keyed off naming conventions. Runs
 * after DB-driven teardown so orphaned team / VK / MCP client / model-config /
 * provider-key bindings are removed even when config-service rows are gone
 * or the async workflow missed a step.
 */
async function sweepBifrostProjectOrphans(
  projectId: string,
  gateway: ILLMGatewayClient,
  axiosClient?: AxiosInstance,
): Promise<{
  mcpClientsRemoved: number;
  modelConfigsRemoved: number;
  providerBindingsRemoved: number;
  virtualKeysRemoved: number;
  teamsRemoved: number;
}> {
  const counts = {
    mcpClientsRemoved: 0,
    modelConfigsRemoved: 0,
    providerBindingsRemoved: 0,
    virtualKeysRemoved: 0,
    teamsRemoved: 0,
  };
  if (!gateway.isEnabled()) return counts;

  const c = axiosClient || createBifrostClient();
  const bindingPrefix = projectMcpClientPrefix(projectId);
  const teamName = projectTeamName(projectId);

  // MCP clients: `<projectId>_<server>`
  try {
    const rows = await fetchBifrostMcpClients(c);
    for (const raw of rows) {
      const entry = parseBifrostMcpListEntry(raw);
      if (!entry?.server_name?.startsWith(bindingPrefix)) continue;
      try {
        await gateway.removeMCPServer(entry.server_id, {
          projectId,
          mcpClientName: entry.server_name,
        });
        counts.mcpClientsRemoved += 1;
      } catch (err: any) {
        safeConsoleWarn(
          `[bifrostProjectGovernance] sweep: removeMCPServer failed for ${safeLog(entry.server_name)}: ${safeLog(err?.message || err)}`,
        );
      }
    }
  } catch (err: any) {
    safeConsoleWarn(
      `[bifrostProjectGovernance] sweep: list MCP clients failed for project ${safeLog(projectId)}: ${safeLog(err?.message || err)}`,
    );
  }

  // Model-configs: bindings are `<projectId>_<cred>_<model>`
  try {
    const raw = await listModelConfigs(c);
    const configs = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { model_configs?: unknown }).model_configs)
        ? ((raw as { model_configs: Array<Record<string, unknown>> }).model_configs)
        : [];
    for (const cfg of configs) {
      const modelName = cfg.model_name as string | undefined;
      if (!modelName?.startsWith(bindingPrefix)) continue;
      const id = cfg.id as string | undefined;
      if (!id) continue;
      try {
        await deleteModelConfig(id, c);
        counts.modelConfigsRemoved += 1;
      } catch (err: any) {
        if (err?.response?.status !== 404) {
          safeConsoleWarn(
            `[bifrostProjectGovernance] sweep: deleteModelConfig failed for ${safeLog(id)}: ${safeLog(err?.message || err)}`,
          );
        }
      }
    }
  } catch (err: any) {
    safeConsoleWarn(
      `[bifrostProjectGovernance] sweep: listModelConfigs failed for project ${safeLog(projectId)}: ${safeLog(err?.message || err)}`,
    );
  }

  // Provider keys: trim or delete bindings prefixed with `<projectId>_`
  try {
    const { providers } = await listGatewayProviders(c);
    for (const p of providers) {
      const providerName = (p as { name?: string }).name;
      if (!providerName) continue;
      const keys = await listProviderKeys(providerName, c);
      for (const key of keys) {
        const keyName = key.name as string;
        const keyId = key.id as string | undefined;
        const models = ((key.models as string[]) || []).filter(Boolean);
        const projectModels = models.filter((m) => m.startsWith(bindingPrefix));
        if (!projectModels.length || !keyId) continue;

        let apiKey: string | undefined;
        const credMatch = /^as-cred-(.+)$/.exec(keyName);
        if (credMatch) {
          apiKey = await readCredentialApiKey(projectId, credMatch[1]);
        }

        try {
          if (projectModels.length === models.length) {
            await deleteProviderKeyById(providerName, keyId, c);
            counts.providerBindingsRemoved += projectModels.length;
          } else {
            for (const modelId of projectModels) {
              await removeProviderModelFromKey(
                providerName,
                keyName,
                modelId,
                c,
                apiKey,
              );
              counts.providerBindingsRemoved += 1;
            }
          }
        } catch (err: any) {
          safeConsoleWarn(
            `[bifrostProjectGovernance] sweep: provider key cleanup failed for ${safeLog(keyName)}: ${safeLog(err?.message || err)}`,
          );
        }
      }
    }
  } catch (err: any) {
    safeConsoleWarn(
      `[bifrostProjectGovernance] sweep: provider key scan failed for project ${safeLog(projectId)}: ${safeLog(err?.message || err)}`,
    );
  }

  // Virtual keys: `as-proj-<projectId>-vk` and rotated `-r<n>` variants
  try {
    const vks = listVirtualKeysArray(await listVirtualKeys(c));
    for (const vk of vks) {
      const vkName = vk.name as string | undefined;
      const vkId = parseVkId(vk);
      if (!vkId || !projectVkNameMatches(vkName, projectId)) continue;
      try {
        await deleteVirtualKey(vkId, c);
        counts.virtualKeysRemoved += 1;
      } catch (err: any) {
        if (err?.response?.status === 404) {
          counts.virtualKeysRemoved += 1;
        } else {
          safeConsoleWarn(
            `[bifrostProjectGovernance] sweep: deleteVirtualKey failed for ${safeLog(vkId)}: ${safeLog(err?.message || err)}`,
          );
        }
      }
    }
  } catch (err: any) {
    safeConsoleWarn(
      `[bifrostProjectGovernance] sweep: listVirtualKeys failed for project ${safeLog(projectId)}: ${safeLog(err?.message || err)}`,
    );
  }

  // Team: `as-proj-<projectId>`
  try {
    const teams = await listTeams(c);
    const match = teams.find((t) => (t.name as string) === teamName);
    const teamId = match ? parseTeamId(match) : undefined;
    if (teamId) {
      try {
        await deleteTeam(teamId, c);
        counts.teamsRemoved += 1;
      } catch (err: any) {
        if (err?.response?.status !== 404) {
          safeConsoleWarn(
            `[bifrostProjectGovernance] sweep: deleteTeam failed for ${safeLog(teamId)}: ${safeLog(err?.message || err)}`,
          );
        }
      }
    }
  } catch (err: any) {
    safeConsoleWarn(
      `[bifrostProjectGovernance] sweep: listTeams failed for project ${safeLog(projectId)}: ${safeLog(err?.message || err)}`,
    );
  }

  return counts;
}

async function mergePutVirtualKey(
  vkId: string,
  patch: Record<string, unknown>,
  client?: AxiosInstance,
): Promise<void> {
  const vk = await getVirtualKey(vkId, client);
  if (!vk) {
    throw new Error(`Bifrost virtual key ${vkId} not found while updating`);
  }
  const teamId =
    (vk.team_id as string | undefined) ??
    ((vk.team as { id?: string } | undefined)?.id);
  const body: Record<string, unknown> = {
    name: vk.name,
    description: vk.description,
    is_active: vk.is_active ?? true,
    provider_configs: Array.isArray(vk.provider_configs) ? vk.provider_configs : [],
    mcp_configs: Array.isArray(vk.mcp_configs) ? vk.mcp_configs : [],
    ...(teamId ? { team_id: teamId } : {}),
    ...patch,
  };
  // Whatever the caller/base supplied (often the GET read-shape), coerce the
  // sibling collections to the PUT write-shape so re-sent fields don't 400.
  body.provider_configs = toVkProviderConfigsWriteShape(body.provider_configs);
  // Scope mcp_configs to this project's own (+ platform) MCP clients. The VK
  // is a full-replace PUT that re-sends whatever the GET returned, so without
  // this guard any cross-project client that ever leaked into the VK would be
  // re-persisted forever, exposing every project's MCP tools to this project's
  // agents. Deriving the owner from the VK name keeps the chokepoint
  // self-contained (no extra projectId threading through every caller).
  body.mcp_configs = filterMcpConfigsToProject(
    toVkMcpConfigsWriteShape(body.mcp_configs),
    projectIdFromVkName(vk.name as string | undefined),
  );
  await updateVirtualKey(vkId, body, client);
}

function parseVkId(vk: Record<string, unknown>): string | undefined {
  const id = vk.id ?? vk.virtual_key_id ?? vk.key_id;
  return id != null ? String(id) : undefined;
}

/**
 * Resolve the Bifrost virtual-key **id** (UUID) for a project by matching the
 * canonical VK name (`as-proj-<projectId>-vk`, including rotated `-r<n>`
 * variants). Returns ``undefined`` when the gateway is unreachable or no VK
 * exists yet. Used to scope Bifrost log queries to a single project's traffic —
 * the logs store keys usage by VK id, and a bare provider/model pair is not
 * unique across projects.
 */
export async function resolveProjectVirtualKeyId(
  projectId: string,
  client?: AxiosInstance,
): Promise<string | undefined> {
  const c = client || createBifrostClient();
  const vks = listVirtualKeysArray(await listVirtualKeys(c));
  const match = vks.find((v) => projectVkNameMatches(v.name as string | undefined, projectId));
  return match ? parseVkId(match) : undefined;
}

function extractVirtualKeyToken(raw: Record<string, unknown>): string | undefined {
  // Bifrost returns the VK bearer in the top-level `value` field on
  // create/list/get responses (e.g. `value: "sk-bf-..."`). The other names
  // are kept for forward/backward compatibility with alternate Bifrost
  // builds. `value` MUST be in this list — omitting it was why the bearer
  // never got persisted to the project's K8s Secret, leaving `/infer` to
  // 503 with "No Bifrost virtual-key token available".
  const key = raw.value ?? raw.key ?? raw.token ?? raw.api_key ?? raw.virtual_key;
  if (typeof key === 'string' && key) return key;
  if (key && typeof key === 'object' && 'value' in (key as object)) {
    const v = (key as { value?: string }).value;
    if (v) return v;
  }
  return undefined;
}

/** Parse bearer from `POST .../virtual-keys/{id}/rotate` response bodies. */
function extractRotatedVirtualKeyToken(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const direct =
    obj.key ??
    obj.secondary_key ??
    obj.secondaryKey ??
    obj.token ??
    obj.api_key ??
    obj.virtual_key;
  if (typeof direct === 'string' && direct) {
    return direct;
  }
  if (direct && typeof direct === 'object') {
    const nested = extractVirtualKeyToken(direct as Record<string, unknown>);
    if (nested) return nested;
  }
  const vk = obj.virtual_key;
  if (vk && typeof vk === 'object') {
    return extractVirtualKeyToken(vk as Record<string, unknown>);
  }
  return undefined;
}

/**
 * Backfill the project's VK bearer K8s Secret when it is missing.
 *
 * The bearer is returned in full by Bifrost on the VK create/list/get
 * responses (`value`), so it can be (re)materialised from a live read at any
 * time. We only write when the Secret is absent/empty, so the common path
 * (Secret already present) costs a single cheap namespaced GET and never
 * churns the Secret. This is what makes a lost Secret — or one that was never
 * written because of an older bug — self-heal on the next
 * `ensureProjectGateway` call instead of permanently 503-ing `/infer`.
 *
 * When `knownToken` is provided (fresh create) we write it directly; the VK
 * is brand-new so there is nothing to preserve.
 */
async function ensureProjectVirtualKeyTokenSecret(
  projectId: string,
  virtualKeyId: string | undefined,
  knownToken: string | undefined,
  client?: AxiosInstance,
): Promise<void> {
  let token = knownToken;
  if (!token) {
    let existing: string | undefined;
    try {
      existing = await readProjectVirtualKeyToken(projectId);
    } catch {
      existing = undefined;
    }
    if (existing) return;
    if (!virtualKeyId) return;
    try {
      const vk = await getVirtualKey(virtualKeyId, client);
      if (vk) token = extractVirtualKeyToken(vk);
    } catch (err: any) {
      console.warn(
        `[bifrostProjectGovernance] Could not fetch VK ${safeLog(virtualKeyId)} to backfill token Secret for project ${safeLog(projectId)}: ${safeLog(err?.message || err)}`,
      );
    }
  }
  if (token) {
    await writeProjectVirtualKeyTokenSecret(projectId, token);
  }
}

async function persistProjectGateway(
  projectId: string,
  gateway: ProjectBifrostGateway,
): Promise<ProjectBifrostGateway> {
  const repo = AppDataSource.getRepository(Project);
  const project = await repo.findOneBy({ id: projectId });
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }
  const metadata = { ...(project.metadata || {}) };
  metadata._gateway = { ...(metadata._gateway || {}), ...gateway };
  await repo.update(projectId, { metadata });
  return gateway;
}

/**
 * Ensure Bifrost team + project virtual key exist; cache ids on projects.metadata._gateway.
 */
export async function ensureProjectGateway(
  projectId: string,
  client?: AxiosInstance,
): Promise<ProjectBifrostGateway | null> {
  const repo = AppDataSource.getRepository(Project);
  const project = await repo.findOneBy({ id: projectId });
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  const cached = project.metadata?._gateway as ProjectBifrostGateway | undefined;

  // Verify the cached ids actually exist in Bifrost. If a user/operator deleted
  // the team or VK directly in Bifrost (or via clear scripts), the cache here
  // would otherwise short-circuit ensure and leave the project ungoverned.
  let existing: ProjectBifrostGateway | undefined = cached;
  if (cached?.teamId || cached?.virtualKeyId) {
    let teamOk = false;
    let vkOk = false;
    if (cached.teamId) {
      try {
        teamOk = !!(await getTeam(cached.teamId, client));
      } catch {
        teamOk = false;
      }
    }
    if (cached.virtualKeyId) {
      try {
        vkOk = !!(await getVirtualKey(cached.virtualKeyId, client));
      } catch {
        vkOk = false;
      }
    }
    if (cached.teamId && cached.virtualKeyId && teamOk && vkOk) {
      // Self-heal a missing bearer Secret even when the team/VK are already
      // cached and valid (e.g. Secret deleted out of band, or never written
      // by an older bug). No-op when the Secret is already populated.
      await ensureProjectVirtualKeyTokenSecret(
        projectId,
        cached.virtualKeyId,
        cached.virtualKeyToken,
        client,
      );
      return cached;
    }
    if (!teamOk || !vkOk) {
      console.log(
        `[bifrostProjectGovernance] Stale cache for ${safeLog(projectId)}: team=${teamOk ? 'ok' : 'missing'} vk=${vkOk ? 'ok' : 'missing'}; recreating`,
      );
      existing = {
        ...(cached as ProjectBifrostGateway),
        ...(teamOk ? {} : { teamId: undefined as unknown as string }),
        ...(vkOk
          ? {}
          : {
              virtualKeyId: undefined as unknown as string,
              virtualKeyToken: undefined,
            }),
      };
    }
  }

  const teamName = projectTeamName(projectId);
  const vkName = projectVirtualKeyName(projectId);

  let teamId = existing?.teamId;
  if (!teamId) {
    const teams = await listTeams(client);
    const match = teams.find((t) => (t.name as string) === teamName);
    if (match) {
      teamId = parseTeamId(match);
      if (!teamId) {
        throw new Error(`Bifrost team ${teamName} exists but has no id`);
      }
    } else {
      const created = await createTeam(
        {
          name: teamName,
          description: `AgentStudio project ${projectId}`,
        },
        client,
      );
      teamId = parseTeamId(created);
      if (!teamId) {
        throw new Error(`Bifrost createTeam did not return team id for ${teamName}`);
      }
      console.log(`[bifrostProjectGovernance] Created team ${safeLog(teamName)} id=${safeLog(teamId)}`);
    }
  }

  if (!teamId) {
    throw new Error(`Bifrost team id required for project ${projectId}`);
  }

  let virtualKeyId = existing?.virtualKeyId;
  let virtualKeyToken = existing?.virtualKeyToken;
  if (!virtualKeyId) {
    const raw = await listVirtualKeys(client);
    const vks = listVirtualKeysArray(raw);
    const vkMatch = vks.find((v) => (v.name as string) === vkName);
    if (vkMatch) {
      virtualKeyId = parseVkId(vkMatch);
      if (!virtualKeyId) {
        throw new Error(`Bifrost virtual key ${vkName} exists but has no id`);
      }
      // Self-heal: existing VKs may have lost their team binding from prior
      // partial PUTs. Re-bind to this project's team if missing or stale.
      const existingTeam =
        (vkMatch.team_id as string | undefined) ??
        ((vkMatch.team as { id?: string } | undefined)?.id);
      if (existingTeam !== teamId) {
        await mergePutVirtualKey(virtualKeyId, { team_id: teamId }, client);
        console.log(
          `[bifrostProjectGovernance] Re-bound existing VK ${safeLog(vkName)} to team ${safeLog(teamId)} (was ${safeLog(existingTeam ?? 'null')})`,
        );
      }
    } else {
      const vkResp = (await createVirtualKey(
        {
          name: vkName,
          description: `AgentStudio project ${projectId}`,
          team_id: teamId,
          is_active: true,
          mcp_configs: [],
        },
        client,
      )) as Record<string, unknown>;
      const vk =
        (vkResp?.virtual_key as Record<string, unknown>) ||
        (vkResp?.key as Record<string, unknown>) ||
        vkResp;
      virtualKeyId = parseVkId(vk);
      virtualKeyToken = extractVirtualKeyToken(vk);
      if (!virtualKeyId) {
        throw new Error(`Bifrost createVirtualKey did not return id for ${vkName}`);
      }

      // Bifrost may not echo team_id reliably on POST (replication lag), and any
      // later partial PUT does a full replace that drops omitted fields. Always
      // re-bind the team immediately after create so subsequent merge PUTs see it.
      await mergePutVirtualKey(virtualKeyId, { team_id: teamId }, client);
      console.log(
        `[bifrostProjectGovernance] Created virtual key ${safeLog(vkName)} id=${safeLog(virtualKeyId)} team=${safeLog(teamId)}`,
      );
    }
  }

  // teamId and virtualKeyId are both guaranteed non-empty strings at
  // this point: every conditional branch above either assigns them or
  // throws (`Bifrost team id required for project ...`, `Bifrost team
  // ${name} exists but has no id`, `Bifrost createVirtualKey did not
  // return id for ${name}`, etc.). A late `if (!teamId ||
  // !virtualKeyId)` re-check used to live here as belt-and-suspenders
  // but CodeQL flagged the inner `?? '(missing)'` expressions as
  // useless conditionals (the variables are typed as `string` after
  // the earlier narrowing throws), and the if-condition itself was
  // unreachable.

  // Persist the VK bearer token to a K8s Secret keyed by projectId.
  // The Secret is the SOLE AgentStudio-side home for the bearer; the
  // token is deliberately NOT written to the project metadata blob in
  // config-service Postgres because that store does not have
  // secret-grade RBAC / audit / encryption-at-rest controls. Failures
  // here are logged inside the helper and do not abort governance
  // setup - the project still has a usable team/VK in Bifrost; the
  // bearer can be recovered on the next ensureProjectGateway run
  // (which re-reads the VK and rewrites the Secret).
  await ensureProjectVirtualKeyTokenSecret(
    projectId,
    virtualKeyId,
    virtualKeyToken,
    client,
  );

  // The metadata blob persists only non-secret identifiers (team /
  // VK ids and names) -- those are useful as a fast cache so
  // ensureProjectGateway can short-circuit without re-listing
  // Bifrost on every call. The bearer token is intentionally
  // omitted here; see scrubProjectMetadataVirtualKeyToken migration
  // in db/postgres.ts which removes any value left from prior writes.
  const gateway: ProjectBifrostGateway = {
    teamId,
    teamName,
    virtualKeyId,
    virtualKeyName: vkName,
  };
  return persistProjectGateway(projectId, gateway);
}

export async function loadProjectGateway(
  projectId: string,
  client?: AxiosInstance,
): Promise<ProjectBifrostGateway | null> {
  const project = await AppDataSource.getRepository(Project).findOneBy({ id: projectId });
  const g = project?.metadata?._gateway as ProjectBifrostGateway | undefined;
  if (g?.teamId && g?.virtualKeyId) return g;
  return ensureProjectGateway(projectId, client);
}

export async function appendMcpClientToProjectVirtualKey(
  projectId: string,
  mcpClientName: string,
  toolsToExecute?: string[],
  client?: AxiosInstance,
): Promise<void> {
  const gateway = await loadProjectGateway(projectId, client);
  if (!gateway) return;

  const tools = toolsToExecute?.length ? toolsToExecute : ['*'];
  const vk = await getVirtualKey(gateway.virtualKeyId, client);
  if (!vk) {
    console.warn(
      `[bifrostProjectGovernance] Virtual key ${safeLog(gateway.virtualKeyId)} not found; skipping mcp_configs`,
    );
    return;
  }

  // Normalize the GET read-shape to the PUT write-shape so the name lookup
  // works (raw GET entries carry the name under `mcp_client`, not
  // `mcp_client_name`) and existing associations keep their id/mcp_client_id.
  const configs = toVkMcpConfigsWriteShape(vk.mcp_configs);
  const idx = configs.findIndex((c) => c.mcp_client_name === mcpClientName);
  if (idx >= 0) {
    configs[idx] = { ...configs[idx], mcp_client_name: mcpClientName, tools_to_execute: tools };
  } else {
    configs.push({ mcp_client_name: mcpClientName, tools_to_execute: tools });
  }

  await mergePutVirtualKey(gateway.virtualKeyId, { mcp_configs: configs }, client);
  console.log(
    `[bifrostProjectGovernance] VK ${safeLog(gateway.virtualKeyName)} mcp_configs += ${safeLog(mcpClientName)}`,
  );
}

/** Synthetic project id that owns platform-managed (shared) MCP servers. */
const PLATFORM_PROJECT_ID = '__platform__';

/** Minimal platform MCP server shape needed to derive its Bifrost client name. */
export interface PlatformMcpServerRef {
  status?: string | null;
  syncStatus?: string | null;
  catalogId?: string | null;
  llmproxyGatewayServerName?: string | null;
  name?: string | null;
}

/**
 * The Bifrost MCP client names for the platform servers that should be exposed
 * to a project, given the rollout flags. Only servers already registered in
 * Bifrost (`syncStatus === 'synced'`, not in `error`) and permitted by
 * {@link isPlatformMcpAutoAttachable} are included; names are de-duplicated.
 */
export function selectPlatformMcpClientNames(
  servers: PlatformMcpServerRef[],
  flags: { webSearch: boolean; analytics: boolean },
): string[] {
  return Array.from(
    new Set(
      servers
        .filter(
          (s) =>
            s.status !== 'error' &&
            s.syncStatus === 'synced' &&
            isPlatformMcpAutoAttachable(s.catalogId, flags),
        )
        .map((s) => s.llmproxyGatewayServerName || s.name?.replace(/-/g, '_'))
        .filter((name): name is string => !!name),
    ),
  );
}

/**
 * Pure merge: append any missing platform MCP client to the VK's current
 * (write-shape) `mcp_configs`. Returns the merged configs plus the names added.
 * Exported as the testable seam behind
 * {@link attachPlatformMcpServersToProjectVirtualKey}.
 */
export function computePlatformMcpConfigAdditions(
  currentConfigs: Array<Record<string, unknown>>,
  servers: PlatformMcpServerRef[],
  flags: { webSearch: boolean; analytics: boolean },
): { configs: Array<Record<string, unknown>>; added: string[] } {
  const configs = [...currentConfigs];
  const present = new Set(
    configs.map((c) => c.mcp_client_name as string).filter(Boolean),
  );
  const added: string[] = [];
  for (const name of selectPlatformMcpClientNames(servers, flags)) {
    if (present.has(name)) continue;
    configs.push({ mcp_client_name: name, tools_to_execute: ['*'] });
    present.add(name);
    added.push(name);
  }
  return { configs, added };
}

/**
 * Attach the platform-managed MCP clients (artifact-store, analytics, ...) to a
 * project's Bifrost virtual key so agents in the project can reach their tools.
 *
 * Platform MCP servers live under the synthetic `__platform__` project and are
 * registered as Bifrost MCP clients with `allow_on_all_virtual_keys: false`
 * (see {@link appendMcpClientToProjectVirtualKey} and
 * `BifrostGatewayClient.addMCPServer`). A client is therefore only reachable by
 * a project VK when its name is present in that VK's `mcp_configs`.
 * Project-scoped servers get this on registration; platform servers are shared
 * and never registered against a real project, so nothing ever added them to a
 * real project's VK — this backfills them at project-init (`gateway-setup`).
 *
 * Behaviour:
 *   - Honors the same web-search/analytics rollout gates as the agent
 *     read-shape ({@link isPlatformMcpAutoAttachable}) so the VK exposes exactly
 *     the platform clients its agents are told about.
 *   - Only considers platform servers already registered in Bifrost
 *     (`syncStatus === 'synced'`); un-synced rows have no client to reference.
 *   - Idempotent: reads the VK once and only PUTs when a platform client is
 *     missing. Platform client names carry no project prefix, so
 *     {@link filterMcpConfigsToProject} preserves them on subsequent merge PUTs.
 *   - Best-effort: callers wrap this so a failure never breaks gateway setup.
 */
export async function attachPlatformMcpServersToProjectVirtualKey(
  projectId: string,
  client?: AxiosInstance,
): Promise<void> {
  if (!projectId || projectId === PLATFORM_PROJECT_ID) return;

  const gateway = await loadProjectGateway(projectId, client);
  if (!gateway) return;

  const platformServers = await AppDataSource.getRepository(MCPServer).find({
    where: { deploymentType: 'platform' },
  });
  if (!platformServers.length) return;

  const flags = readPlatformMcpAutoAttachFlags();
  if (!selectPlatformMcpClientNames(platformServers, flags).length) return;

  const vk = await getVirtualKey(gateway.virtualKeyId, client);
  if (!vk) {
    safeConsoleWarn(
      `[bifrostProjectGovernance] VK ${safeLog(gateway.virtualKeyId)} not found; skipping platform mcp_configs for project ${safeLog(projectId)}`,
    );
    return;
  }

  const { configs, added } = computePlatformMcpConfigAdditions(
    toVkMcpConfigsWriteShape(vk.mcp_configs),
    platformServers,
    flags,
  );
  if (!added.length) return;

  await mergePutVirtualKey(gateway.virtualKeyId, { mcp_configs: configs }, client);
  safeConsoleLog(
    `[bifrostProjectGovernance] VK ${safeLog(gateway.virtualKeyName)} platform mcp_configs += ${safeLog(added.join(', '))}`,
  );
}

/**
 * Inverse of {@link appendMcpClientToProjectVirtualKey}: drop the named
 * Bifrost MCP client from the project virtual key's `mcp_configs[]`
 * list, so requests carrying that VK can no longer reach the MCP
 * server's tools.
 *
 * Idempotent: silently no-ops when (a) the project has no Bifrost
 * governance set up (cached gateway is absent), or (b) the VK has been
 * deleted out of band, or (c) the VK has no `mcp_configs` at all.
 * Called from `BifrostGatewayClient.removeMCPServer` (deregistering a
 * single MCP server) and from `teardownProjectGateway` (project
 * deletion clean-up sweep), both of which expect repeated calls to be
 * safe.
 */
export async function removeMcpClientFromProjectVirtualKey(
  projectId: string,
  mcpClientName: string,
  client?: AxiosInstance,
): Promise<void> {
  const gateway = await loadProjectGateway(projectId, client);
  if (!gateway) return;

  const vk = await getVirtualKey(gateway.virtualKeyId, client);
  if (!vk || !Array.isArray(vk.mcp_configs)) return;

  const normalized = toVkMcpConfigsWriteShape(vk.mcp_configs);
  const before = normalized.length;
  const configs = normalized.filter((c) => c.mcp_client_name !== mcpClientName);
  if (configs.length === before) return; // nothing to do
  await mergePutVirtualKey(gateway.virtualKeyId, { mcp_configs: configs }, client);
  console.log(
    `[bifrostProjectGovernance] VK ${safeLog(gateway.virtualKeyName)} mcp_configs -= ${safeLog(mcpClientName)}`,
  );
}

/**
 * `key_ids` restricts the VK to specific provider API keys (deny-by-default
 * when empty). Bifrost's GET response returns full key objects under `keys`,
 * but `PUT` only writes `key_ids` (string array). Flatten anything we
 * received into a unique id list so the binding persists on write.
 */
function extractProviderConfigKeyIds(entry: Record<string, unknown>): string[] {
  const flat: string[] = [];
  const fromKeyIds = entry.key_ids as unknown;
  if (Array.isArray(fromKeyIds)) {
    for (const v of fromKeyIds) {
      if (typeof v === 'string' && v) flat.push(v);
    }
  }
  const fromKeys = entry.keys as unknown;
  if (Array.isArray(fromKeys)) {
    for (const v of fromKeys as Array<Record<string, unknown> | string>) {
      if (typeof v === 'string' && v) flat.push(v);
      else if (v && typeof v === 'object') {
        const id =
          (v as { key_id?: string }).key_id ||
          (v as { id?: string | number }).id;
        if (typeof id === 'string' && id) flat.push(id);
      }
    }
  }
  return Array.from(new Set(flat));
}

/** Coerce a provider_config entry to the PUT write-shape (`key_ids` only). */
function normalizeProviderConfigEntry(
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...entry };
  const ids = extractProviderConfigKeyIds(next);
  delete next.keys; // write-shape uses key_ids only
  if (ids.length) next.key_ids = ids;
  return next;
}

/**
 * Merge one (provider, model) binding into a normalized `provider_configs`
 * array IN PLACE, returning whether anything changed. Shared by the single
 * ({@link assignModelToProjectVirtualKey}) and batched
 * ({@link assignBuiltinModelsToProjectVirtualKey}) assign paths so both
 * apply identical merge semantics (platform-TEI alias collapsing, key_id
 * union, provider entry creation).
 */
function mergeBindingIntoProviderConfigs(
  configs: Array<Record<string, unknown>>,
  binding: { provider: string; modelId: string; providerKeyId?: string },
): boolean {
  let changed = false;
  const idx = configs.findIndex(
    (c) => (c.provider as string | undefined) === binding.provider,
  );
  if (idx >= 0) {
    const entry = configs[idx];
    let allowed = Array.isArray(entry.allowed_models)
      ? [...(entry.allowed_models as string[])]
      : [];
    const priorAllowed = [...allowed];
    if (isPlatformTeiProvider(binding.provider)) {
      allowed = mergeBuiltinVirtualKeyAllowedModels(allowed, binding.modelId);
    } else if (!allowed.includes(binding.modelId)) {
      allowed.push(binding.modelId);
    }
    if (
      allowed.length !== priorAllowed.length ||
      allowed.some((m, i) => m !== priorAllowed[i])
    ) {
      entry.allowed_models = allowed;
      changed = true;
    }
    if (binding.providerKeyId) {
      const keyIds = Array.isArray(entry.key_ids)
        ? [...(entry.key_ids as string[])]
        : [];
      if (!keyIds.includes(binding.providerKeyId)) {
        keyIds.push(binding.providerKeyId);
        entry.key_ids = keyIds;
        changed = true;
      }
    }
  } else {
    configs.push({
      provider: binding.provider,
      weight: 1.0,
      allowed_models: [binding.modelId],
      ...(binding.providerKeyId ? { key_ids: [binding.providerKeyId] } : {}),
    });
    changed = true;
  }
  return changed;
}

/**
 * Pure merge of many (provider, model) bindings into a VK's `provider_configs`.
 *
 * Normalizes the raw (GET read-shape) configs to the PUT write-shape, then
 * folds every binding in via {@link mergeBindingIntoProviderConfigs}. Returns
 * the merged configs plus whether anything changed. Exported as the testable
 * seam behind {@link assignBuiltinModelsToProjectVirtualKey} — it captures the
 * invariant that batching all catalog built-ins yields ALL of them (the fix
 * for the concurrent per-model lost-update race), while preserving unrelated
 * provider entries (e.g. user-registered azure/openai models).
 */
export function applyBuiltinBindingsToProviderConfigs(
  rawConfigs: Array<Record<string, unknown>>,
  bindings: Array<{ provider: string; modelId: string; providerKeyId?: string }>,
): { configs: Array<Record<string, unknown>>; changed: boolean } {
  const configs = (Array.isArray(rawConfigs) ? rawConfigs : []).map(
    normalizeProviderConfigEntry,
  );
  let changed = false;
  for (const binding of bindings) {
    if (mergeBindingIntoProviderConfigs(configs, binding)) changed = true;
  }
  return { configs, changed };
}

/**
 * Bind an AgentStudio-registered model to the project virtual key so
 * Bifrost will route requests carrying that VK to the upstream model.
 *
 * Stored on the VK as a `provider_configs` entry per Bifrost provider:
 *   `{ provider, allowed_models: [...], key_ids: [...] }`.
 *
 * The `binding.modelId` placed in `allowed_models` is the **bare**
 * gateway binding name (e.g. `<projectId>__<credShort>__<providerModelId>`
 * for the new scheme, or `gpt-4o` for legacy non-binding flows).
 * The matching `binding.provider` is the Bifrost-side provider name
 * (`azure`, `openai`, `bedrock`, ...) -- NOT the AgentStudio-side
 * llmProvider value. On the wire, callers send the provider-prefixed
 * form as `request.model` (e.g. `azure/<binding>`); Bifrost splits at
 * the `/`, matches the prefix against the `provider` field of the
 * `provider_configs` entries, and the suffix against that entry's
 * `allowed_models[]`.
 *
 * `provider_configs` is the SOLE source of model dispatch info on the
 * Bifrost side -- there are no per-model routing rules in this PR (see
 * `bifrostOps.ts` for the rationale). Without this binding, Bifrost
 * authenticates the VK successfully but then refuses the request
 * because the model isn't in the VK's allowed list.
 */
export async function assignModelToProjectVirtualKey(
  projectId: string,
  binding: { provider: string; modelId: string; providerKeyId?: string },
  client?: AxiosInstance,
): Promise<void> {
  const gateway = await loadProjectGateway(projectId, client);
  if (!gateway) return;

  const vk = await getVirtualKey(gateway.virtualKeyId, client);
  if (!vk) {
    console.warn(
      `[bifrostProjectGovernance] VK ${safeLog(gateway.virtualKeyId)} not found; skipping provider_configs for model ${safeLog(binding.modelId)}`,
    );
    return;
  }

  const configs = (
    Array.isArray(vk.provider_configs)
      ? (vk.provider_configs as Array<Record<string, unknown>>)
      : []
  ).map(normalizeProviderConfigEntry);

  const changed = mergeBindingIntoProviderConfigs(configs, binding);
  if (!changed) return;

  await mergePutVirtualKey(gateway.virtualKeyId, { provider_configs: configs }, client);
  // Log the stored shape, not the wire-form. provider_configs[<provider>]
  // gets `<bare-binding>` appended to allowed_models; on the wire callers
  // send `<provider>/<bare-binding>` as request.model.
  console.log(
    `[bifrostProjectGovernance] VK ${safeLog(gateway.virtualKeyName)} provider_configs[${safeLog(binding.provider)}].allowed_models += ${safeLog(binding.modelId)}` +
      (binding.providerKeyId ? ` key_id=${safeLog(binding.providerKeyId)}` : ''),
  );
}

/**
 * Batched, race-free variant of {@link assignModelToProjectVirtualKey}.
 *
 * Adds MANY (provider, model) bindings to the project virtual key in a
 * SINGLE read-modify-write instead of one GET→PUT per model. This is the
 * fix for the built-in registration race: `registerBuiltinsWithGatewayFor
 * Project` used to fan out one `assignModelToProjectVirtualKey` per
 * built-in concurrently, and because each did its own full-replace PUT of
 * `provider_configs`, concurrent calls clobbered each other (lost update)
 * so the VK ended up with only a non-deterministic subset of the catalog.
 * Collapsing all built-ins into one PUT removes the shared-resource
 * contention entirely.
 *
 * Idempotent: platform-TEI providers collapse legacy project-scoped aliases
 * to the canonical binding (via `mergeBuiltinVirtualKeyAllowedModels`);
 * other providers append the binding if absent. Provider entries NOT named
 * in `bindings` (e.g. user-registered azure/openai models) are preserved
 * untouched.
 */
export async function assignBuiltinModelsToProjectVirtualKey(
  projectId: string,
  bindings: Array<{ provider: string; modelId: string; providerKeyId?: string }>,
  client?: AxiosInstance,
): Promise<void> {
  if (!bindings.length) return;
  const gateway = await loadProjectGateway(projectId, client);
  if (!gateway) return;

  const vk = await getVirtualKey(gateway.virtualKeyId, client);
  if (!vk) {
    console.warn(
      `[bifrostProjectGovernance] VK ${safeLog(gateway.virtualKeyId)} not found; skipping batched provider_configs for ${bindings.length} model(s)`,
    );
    return;
  }

  const rawConfigs = Array.isArray(vk.provider_configs)
    ? (vk.provider_configs as Array<Record<string, unknown>>)
    : [];
  const { configs, changed } = applyBuiltinBindingsToProviderConfigs(
    rawConfigs,
    bindings,
  );
  if (!changed) return;

  await mergePutVirtualKey(gateway.virtualKeyId, { provider_configs: configs }, client);
  console.log(
    `[bifrostProjectGovernance] VK ${safeLog(gateway.virtualKeyName)} batched provider_configs assign of ${bindings.length} built-in model(s): ${safeLog(
      bindings.map((b) => `${b.provider}/${b.modelId}`).join(', '),
    )}`,
  );
}

export async function unassignModelFromProjectVirtualKey(
  projectId: string,
  binding: { provider: string; modelId: string },
  client?: AxiosInstance,
): Promise<void> {
  const gateway = await loadProjectGateway(projectId, client);
  if (!gateway) return;

  const vk = await getVirtualKey(gateway.virtualKeyId, client);
  if (!vk || !Array.isArray(vk.provider_configs)) return;

  const configs = (vk.provider_configs as Array<Record<string, unknown>>)
    .map((entry) => {
      if ((entry.provider as string | undefined) !== binding.provider) return entry;
      const allowed = Array.isArray(entry.allowed_models)
        ? (entry.allowed_models as string[]).filter((m) => m !== binding.modelId)
        : [];
      return { ...entry, allowed_models: allowed };
    })
    .filter((entry) => {
      const allowed = entry.allowed_models as string[] | undefined;
      return Array.isArray(allowed) && allowed.length > 0;
    });

  await mergePutVirtualKey(gateway.virtualKeyId, { provider_configs: configs }, client);
  console.log(
    `[bifrostProjectGovernance] VK ${safeLog(gateway.virtualKeyName)} provider_configs -= ${safeLog(binding.provider)}/${safeLog(binding.modelId)}`,
  );
}

// -- Per-model governance (Bifrost model-configs) ---------------------------
//
// Bifrost enforces budgets + rate limits at the virtual-key and
// provider-config levels, and — via `model-configs` — at the individual
// model level. We map each AgentStudio model's `rpm` / `tpm` /
// `spendingLimit` onto a `model-config` scoped to the project's virtual key
// (`scope=virtual_key`), keyed on the same `gatewayBindingName` that lives in
// the VK's `provider_configs[].allowed_models` and the bifrost provider name.
// Budget + rate-limit are sent inline (the create/update model-config API
// accepts `budgets[]` + `rate_limit` directly, no separate id references).

/** Per-model governance limits sourced from the AgentStudio model row. */
export interface ModelGovernanceLimits {
  /** Requests per minute. */
  rpm?: number | null;
  /** Tokens per minute. */
  tpm?: number | null;
  /** Spending cap in USD over `spendingLimitPeriod`. */
  spendingLimit?: number | null;
  /** Window for `spendingLimit`. */
  spendingLimitPeriod?: 'day' | 'week' | 'month' | null;
}

/** Map an AgentStudio spending period onto a Bifrost `reset_duration`. */
function spendingPeriodToResetDuration(period?: string | null): string {
  switch (period) {
    case 'day':
      return '1d';
    case 'week':
      return '1w';
    case 'month':
      return '1M';
    default:
      return '1M';
  }
}

/** True when at least one governance limit is a positive number. */
function hasGovernanceLimits(limits: ModelGovernanceLimits): boolean {
  return (
    (typeof limits.rpm === 'number' && limits.rpm > 0) ||
    (typeof limits.tpm === 'number' && limits.tpm > 0) ||
    (typeof limits.spendingLimit === 'number' && limits.spendingLimit > 0)
  );
}

/** Build the Bifrost `model-config` request body for a model's limits. */
function buildModelConfigBody(
  modelName: string,
  provider: string,
  virtualKeyId: string,
  limits: ModelGovernanceLimits,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model_name: modelName,
    provider,
    scope: 'virtual_key',
    scope_id: virtualKeyId,
  };

  if (typeof limits.spendingLimit === 'number' && limits.spendingLimit > 0) {
    // Bifrost model-config expects a singular `budget` object; using
    // `budgets[]` is accepted but ignored, which drops spending limits while
    // still persisting rate_limit.
    body.budget = {
      max_limit: limits.spendingLimit,
      reset_duration: spendingPeriodToResetDuration(limits.spendingLimitPeriod),
    };
  }

  const rateLimit: Record<string, unknown> = {};
  if (typeof limits.rpm === 'number' && limits.rpm > 0) {
    rateLimit.request_max_limit = limits.rpm;
    rateLimit.request_reset_duration = '1m';
  }
  if (typeof limits.tpm === 'number' && limits.tpm > 0) {
    rateLimit.token_max_limit = limits.tpm;
    rateLimit.token_reset_duration = '1m';
  }
  if (Object.keys(rateLimit).length > 0) {
    body.rate_limit = rateLimit;
  }

  return body;
}

/** Normalize Bifrost's model-config list response into a flat array. */
function modelConfigArray(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  const obj = raw as Record<string, unknown> | null;
  if (obj && Array.isArray(obj.data)) return obj.data as Array<Record<string, unknown>>;
  if (obj && Array.isArray(obj.model_configs)) {
    return obj.model_configs as Array<Record<string, unknown>>;
  }
  return [];
}

/** Find an existing model-config id for this (model, provider, VK), if any. */
function findExistingModelConfigId(
  configs: Array<Record<string, unknown>>,
  modelName: string,
  provider: string,
  virtualKeyId: string,
): string | undefined {
  const match = configs.find(
    (c) => {
      if ((c.model_name as string | undefined) !== modelName) return false;
      if ((c.provider as string | undefined) !== provider) return false;
      const scope = c.scope as string | undefined;
      const scopeId = c.scope_id as string | undefined;
      // Some Bifrost list responses omit scope/scope_id even though the
      // record is virtual-key-scoped. When absent, fall back to
      // model_name+provider identity to avoid false "create" conflicts.
      if (!scope && !scopeId) return true;
      return scope === 'virtual_key' && scopeId === virtualKeyId;
    },
  );
  if (!match) return undefined;
  const id = match.id ?? (match.model_config as { id?: unknown } | undefined)?.id;
  if (typeof id === 'string') return id;
  return id != null ? String(id) : undefined;
}

/**
 * Apply per-model budget + rate limit to the project's virtual key via a
 * Bifrost `model-config` (scope=virtual_key). Idempotent: updates an existing
 * model-config when one already exists for this (model, provider, VK), else
 * creates one. Best-effort — a governance write failure is logged and does
 * NOT abort model registration (the model still routes; the limits are just
 * absent until the next successful sync).
 */
export async function assignModelGovernance(
  projectId: string,
  binding: { provider: string; modelName: string },
  limits: ModelGovernanceLimits,
  client?: AxiosInstance,
): Promise<void> {
  if (!hasGovernanceLimits(limits)) return;

  const gateway = await loadProjectGateway(projectId, client);
  if (!gateway) {
    safeConsoleWarn(
      `[bifrostProjectGovernance] No project gateway for ${safeLog(projectId)}; skipping model governance for ${safeLog(binding.modelName)}`,
    );
    return;
  }

  const body = buildModelConfigBody(
    binding.modelName,
    binding.provider,
    gateway.virtualKeyId,
    limits,
  );

  let existingId: string | undefined;
  try {
    const configs = modelConfigArray(await listModelConfigs(client));
    existingId = findExistingModelConfigId(
      configs,
      binding.modelName,
      binding.provider,
      gateway.virtualKeyId,
    );
  } catch (err) {
    // Listing failed — fall through to create. Bifrost rejects true
    // duplicates on its own; a transient list error shouldn't block the write.
    safeConsoleWarn(
      `[bifrostProjectGovernance] listModelConfigs failed for ${safeLog(projectId)}: ${safeLog((err as Error).message)}`,
    );
  }

  if (existingId) {
    await updateModelConfig(existingId, body, client);
    safeConsoleLog(
      `[bifrostProjectGovernance] Updated model-config ${safeLog(existingId)} for ${safeLog(binding.provider)}/${safeLog(binding.modelName)} on VK ${safeLog(gateway.virtualKeyName)}`,
    );
  } else {
    try {
      await createModelConfig(body, client);
      safeConsoleLog(
        `[bifrostProjectGovernance] Created model-config for ${safeLog(binding.provider)}/${safeLog(binding.modelName)} on VK ${safeLog(gateway.virtualKeyName)}`,
      );
    } catch (err: any) {
      // Concurrent writers (or a stale list response) can race into a 409 on
      // create; recover by re-listing and updating the existing config.
      if (err?.response?.status !== 409) throw err;
      const configs = modelConfigArray(await listModelConfigs(client));
      const conflictId = findExistingModelConfigId(
        configs,
        binding.modelName,
        binding.provider,
        gateway.virtualKeyId,
      );
      if (!conflictId) throw err;
      await updateModelConfig(conflictId, body, client);
      safeConsoleLog(
        `[bifrostProjectGovernance] Updated model-config ${safeLog(conflictId)} after 409 conflict for ${safeLog(binding.provider)}/${safeLog(binding.modelName)} on VK ${safeLog(gateway.virtualKeyName)}`,
      );
    }
  }
}

/**
 * Remove the per-model governance `model-config` for this (model, provider,
 * VK). Best-effort / 404-tolerant so model teardown can re-run safely.
 */
export async function removeModelGovernance(
  projectId: string,
  binding: { provider: string; modelName: string },
  client?: AxiosInstance,
): Promise<void> {
  const gateway = await loadProjectGateway(projectId, client);
  if (!gateway) return;

  let existingId: string | undefined;
  try {
    const configs = modelConfigArray(await listModelConfigs(client));
    existingId = findExistingModelConfigId(
      configs,
      binding.modelName,
      binding.provider,
      gateway.virtualKeyId,
    );
  } catch {
    return;
  }
  if (!existingId) return;

  try {
    await deleteModelConfig(existingId, client);
    safeConsoleLog(
      `[bifrostProjectGovernance] Deleted model-config ${safeLog(existingId)} for ${safeLog(binding.provider)}/${safeLog(binding.modelName)}`,
    );
  } catch (err) {
    safeConsoleWarn(
      `[bifrostProjectGovernance] deleteModelConfig failed for ${safeLog(existingId)}: ${safeLog((err as Error).message)}`,
    );
  }
}

export interface RotateProjectVirtualKeyResult {
  projectId: string;
  skipped: boolean;
  skipReason?: string;
  /** Same id before/after native rotate; legacy flow used a new id. */
  virtualKeyId?: string;
  virtualKeyName?: string;
  /** @deprecated Prefer virtualKeyId — kept for workflow-engine wire compat. */
  oldVirtualKeyId?: string;
  /** @deprecated Prefer virtualKeyId — kept for workflow-engine wire compat. */
  newVirtualKeyId?: string;
  /** @deprecated Legacy create-and-delete rotation only. */
  newVirtualKeyName?: string;
  secondaryKeyIssued?: boolean;
}

export interface DeleteRetiredProjectVirtualKeyResult {
  projectId: string;
  deleted: boolean;
  /** `promote-secondary` or legacy `delete` of a replacement VK. */
  method?: 'promote-secondary' | 'delete-legacy';
  retiredVirtualKeyId?: string;
}

function isNativeRotationUnsupported(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status === 404 || status === 405;
}

function nextRotatedVirtualKeyName(projectId: string, currentName: string): string {
  const base = projectVirtualKeyName(projectId);
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}-r(\\d+)$`);
  const m = currentName.match(re);
  if (m) {
    return `${base}-r${parseInt(m[1], 10) + 1}`;
  }
  return `${base}-r1`;
}

/** Copy VK bindings into createVirtualKey shape (strip nested ids). */
function cloneVkConfigsForCreate(
  vk: Record<string, unknown>,
  ownerProjectId?: string,
): { provider_configs: Array<Record<string, unknown>>; mcp_configs: Array<Record<string, unknown>> } {
  const provider_configs = (Array.isArray(vk.provider_configs) ? vk.provider_configs : []).map(
    (entry) => {
      const row = entry as Record<string, unknown>;
      return {
        provider: row.provider,
        weight: row.weight ?? 1,
        allowed_models: row.allowed_models,
        key_ids: row.key_ids,
        keys: row.keys,
      };
    },
  );
  const mcp_configs = (Array.isArray(vk.mcp_configs) ? vk.mcp_configs : []).map((entry) => {
    const row = entry as Record<string, unknown>;
    const client = row.mcp_client as { name?: string } | undefined;
    const name =
      (row.mcp_client_name as string | undefined) ||
      client?.name ||
      (row.name as string | undefined);
    if (!name) return null;
    const tools = row.tools_to_execute;
    return {
      mcp_client_name: name,
      tools_to_execute: Array.isArray(tools) && tools.length ? tools : ['*'],
    };
  }).filter(Boolean) as Array<Record<string, unknown>>;
  // Never carry another project's MCP clients into a freshly rotated VK.
  return {
    provider_configs,
    mcp_configs: filterMcpConfigsToProject(mcp_configs, ownerProjectId),
  };
}

/**
 * Legacy rotation for Bifrost builds without POST .../rotate (e.g. v1.4.11):
 * create a new VK, copy bindings, update K8s secret + metadata.
 */
async function rotateProjectVirtualKeyLegacy(
  projectId: string,
  gateway: ProjectBifrostGateway,
  oldVirtualKeyId: string,
  oldVk: Record<string, unknown>,
  client?: AxiosInstance,
): Promise<RotateProjectVirtualKeyResult> {
  const currentName =
    (gateway.virtualKeyName as string | undefined) ||
    (oldVk.name as string | undefined) ||
    projectVirtualKeyName(projectId);
  const newVkName = nextRotatedVirtualKeyName(projectId, currentName);
  const { provider_configs, mcp_configs } = cloneVkConfigsForCreate(oldVk, projectId);

  const vkResp = (await createVirtualKey(
    {
      name: newVkName,
      description: `AgentStudio project ${projectId} (rotated)`,
      team_id: gateway.teamId,
      is_active: true,
      provider_configs,
      mcp_configs,
    },
    client,
  )) as Record<string, unknown>;
  const vk =
    (vkResp?.virtual_key as Record<string, unknown>) ||
    (vkResp?.key as Record<string, unknown>) ||
    vkResp;
  const newVirtualKeyId = parseVkId(vk);
  const virtualKeyToken = extractVirtualKeyToken(vk);
  if (!newVirtualKeyId) {
    throw new Error(`Bifrost createVirtualKey did not return id for ${newVkName}`);
  }

  await mergePutVirtualKey(newVirtualKeyId, { team_id: gateway.teamId }, client);

  if (!virtualKeyToken) {
    throw new Error(`Bifrost createVirtualKey did not return bearer for ${newVkName}`);
  }
  await writeProjectVirtualKeyTokenSecret(projectId, virtualKeyToken, { required: true });

  const updated: ProjectBifrostGateway = {
    teamId: gateway.teamId,
    teamName: gateway.teamName || projectTeamName(projectId),
    virtualKeyId: newVirtualKeyId,
    virtualKeyName: newVkName,
    pendingRotationOldVirtualKeyId: oldVirtualKeyId,
  };
  await persistProjectGateway(projectId, updated);

  safeConsoleLog(
    '[bifrostProjectGovernance] Legacy VK rotation',
    projectId,
    oldVirtualKeyId,
    newVirtualKeyId,
    newVkName,
  );

  return {
    projectId,
    skipped: false,
    virtualKeyId: newVirtualKeyId,
    virtualKeyName: newVkName,
    oldVirtualKeyId,
    newVirtualKeyId,
    newVirtualKeyName: newVkName,
    secondaryKeyIssued: true,
  };
}

/** Projects with an active Bifrost virtual key (metadata._gateway.virtualKeyId). */
export async function listProjectsForVirtualKeyRotation(): Promise<string[]> {
  const repo = AppDataSource.getRepository(Project);
  const projects = await repo.find({ select: ['id', 'metadata'] });
  return projects
    .filter((p) => {
      const g = p.metadata?._gateway as ProjectBifrostGateway | undefined;
      return !!(g?.teamId && g?.virtualKeyId);
    })
    .map((p) => p.id);
}

/**
 * Rotate the project VK. Tries Bifrost native `POST .../rotate` when available;
 * on 404/405 falls back to create-replacement-VK (works on v1.4.11).
 */
export async function rotateProjectVirtualKey(
  projectId: string,
  client?: AxiosInstance,
): Promise<RotateProjectVirtualKeyResult> {
  const repo = AppDataSource.getRepository(Project);
  const project = await repo.findOneBy({ id: projectId });
  if (!project) {
    return { projectId, skipped: true, skipReason: 'project_not_found' };
  }

  const gateway = project.metadata?._gateway as ProjectBifrostGateway | undefined;
  if (!gateway?.teamId || !gateway?.virtualKeyId) {
    return { projectId, skipped: true, skipReason: 'no_gateway' };
  }

  const virtualKeyId = gateway.virtualKeyId;
  const virtualKeyName =
    gateway.virtualKeyName || projectVirtualKeyName(projectId);

  const vk = await getVirtualKey(virtualKeyId, client);
  if (!vk) {
    return { projectId, skipped: true, skipReason: 'current_vk_missing' };
  }

  // Retry path: rotation already started — re-sync K8s from Bifrost's current token.
  if (gateway.vkRotationPending || gateway.pendingRotationOldVirtualKeyId) {
    const currentToken = extractVirtualKeyToken(vk);
    if (currentToken) {
      await writeProjectVirtualKeyTokenSecret(projectId, currentToken, { required: true });
    }
    return {
      projectId,
      skipped: false,
      virtualKeyId: gateway.virtualKeyId,
      virtualKeyName: gateway.virtualKeyName || virtualKeyName,
      oldVirtualKeyId: gateway.pendingRotationOldVirtualKeyId || virtualKeyId,
      newVirtualKeyId: gateway.virtualKeyId,
      newVirtualKeyName: gateway.virtualKeyName || virtualKeyName,
      secondaryKeyIssued: false,
    };
  }

  try {
    const rotateResp = await rotateVirtualKey(virtualKeyId, {}, client);
    const rotatedToken = extractRotatedVirtualKeyToken(rotateResp);
    if (!rotatedToken) {
      throw new Error(
        `Bifrost rotate for VK ${virtualKeyId} did not return a new sk-bf-* bearer`,
      );
    }

    await writeProjectVirtualKeyTokenSecret(projectId, rotatedToken, { required: true });

    const updated: ProjectBifrostGateway = {
      teamId: gateway.teamId,
      teamName: gateway.teamName || projectTeamName(projectId),
      virtualKeyId,
      virtualKeyName,
      vkRotationPending: true,
    };
    await persistProjectGateway(projectId, updated);

    safeConsoleLog(
      '[bifrostProjectGovernance] Rotated VK; Bifrost + K8s Secret updated',
      projectId,
      virtualKeyId,
      projectVirtualKeySecretName(projectId),
    );

    return {
      projectId,
      skipped: false,
      virtualKeyId,
      virtualKeyName,
      oldVirtualKeyId: virtualKeyId,
      newVirtualKeyId: virtualKeyId,
      newVirtualKeyName: virtualKeyName,
      secondaryKeyIssued: true,
    };
  } catch (err) {
    if (!isNativeRotationUnsupported(err)) {
      throw err;
    }
    safeConsoleLog(
      '[bifrostProjectGovernance] Native rotate unsupported; using legacy create-and-replace',
      projectId,
    );
    return rotateProjectVirtualKeyLegacy(projectId, gateway, virtualKeyId, vk, client);
  }
}

/**
 * Finalize rotation after the grace period. Prefer Bifrost
 * `POST .../virtual-keys/{id}/promote-secondary`; fall back to deleting a
 * legacy replacement VK when `pendingRotationOldVirtualKeyId` is set.
 */
export async function deleteRetiredProjectVirtualKey(
  projectId: string,
  client?: AxiosInstance,
): Promise<DeleteRetiredProjectVirtualKeyResult> {
  const repo = AppDataSource.getRepository(Project);
  const project = await repo.findOneBy({ id: projectId });
  if (!project) {
    return { projectId, deleted: false };
  }

  const gateway = project.metadata?._gateway as ProjectBifrostGateway | undefined;
  if (!gateway?.virtualKeyId) {
    return { projectId, deleted: false };
  }

  if (gateway.vkRotationPending) {
    try {
      await promoteSecondaryVirtualKey(gateway.virtualKeyId, client);
      safeConsoleLog(
        '[bifrostProjectGovernance] Promoted secondary VK',
        projectId,
        gateway.virtualKeyId,
      );
    } catch (err: any) {
      const status = err.response?.status;
      // v1.5.7+ exposes POST .../rotate (returns new primary token) but may not
      // ship promote-secondary yet; treat 404/405 as already-finalized.
      if (status === 405 || status === 404) {
        safeConsoleLog(
          '[bifrostProjectGovernance] promote-secondary unavailable; assuming rotate finalized',
          projectId,
          status,
        );
      } else if (status === 409 || status === 400) {
        safeConsoleLog(
          '[bifrostProjectGovernance] promote-secondary treated as done',
          projectId,
          status,
          err?.message || err,
        );
      } else {
        throw err;
      }
    }

    const metadata = { ...(project.metadata || {}) };
    const g = { ...(metadata._gateway || {}) } as ProjectBifrostGateway;
    delete g.vkRotationPending;
    delete g.pendingRotationOldVirtualKeyId;
    metadata._gateway = g;
    await repo.update(projectId, { metadata });

    return {
      projectId,
      deleted: true,
      method: 'promote-secondary',
      retiredVirtualKeyId: gateway.virtualKeyId,
    };
  }

  const retiredId = gateway.pendingRotationOldVirtualKeyId;
  if (!retiredId) {
    return { projectId, deleted: false };
  }

  try {
    await deleteVirtualKey(retiredId, client);
    safeConsoleLog(
      '[bifrostProjectGovernance] Deleted legacy retired VK',
      retiredId,
      projectId,
    );
  } catch (err: any) {
    if (err.response?.status !== 404) {
      throw err;
    }
    safeConsoleLog(
      '[bifrostProjectGovernance] Legacy retired VK already gone',
      retiredId,
      projectId,
    );
  }

  const metadata = { ...(project.metadata || {}) };
  const g = { ...(metadata._gateway || {}) } as ProjectBifrostGateway;
  delete g.pendingRotationOldVirtualKeyId;
  metadata._gateway = g;
  await repo.update(projectId, { metadata });

  return {
    projectId,
    deleted: true,
    method: 'delete-legacy',
    retiredVirtualKeyId: retiredId,
  };
}

/**
 * Optional pre-loaded gateway metadata passed to {@link teardownProjectGateway}.
 *
 * When the teardown runs as part of `ProjectDeleteWorkflow` (i.e. the call
 * arrives via `POST /api/v1/internal/projects/:projectId/gateway-teardown`)
 * the project row in config-service Postgres may already have been deleted
 * by the time the activity executes — the workflow runs asynchronously
 * after the DELETE handler returns 204. In that case there's no row to
 * read `metadata._gateway` from. The handler captures the cached ids
 * before kicking the workflow off and passes them down here so the
 * teardown can still find the VK / team to drop in Bifrost's
 * `config_store`. When this is omitted the function falls back to the
 * legacy DB-read path (only safe when called inline from the handler
 * with the row still present).
 */
export interface PreloadedProjectGateway {
  teamId?: string | null;
  teamName?: string | null;
  virtualKeyId?: string | null;
  virtualKeyName?: string | null;
}

/** Summary returned by {@link teardownProjectGateway}. */
export interface ProjectGatewayTeardownResult {
  /** Models found in config-service DB for this project. */
  modelsFound: number;
  /** Models whose Bifrost entries (routing rule, VK provider_configs, provider-key models[]) were removed. */
  modelsRemoved: number;
  /** Models whose Bifrost cleanup raised (cleanup continues; failures logged). */
  modelsFailed: number;
  /** MCP servers found in config-service DB for this project. */
  mcpServersFound: number;
  /** MCP servers whose Bifrost client + VK mcp_configs entry were removed. */
  mcpServersRemoved: number;
  /** MCP servers whose Bifrost cleanup raised. */
  mcpServersFailed: number;
  /** Bifrost virtual-key deleted (true even when it was already gone). */
  virtualKeyDeleted: boolean;
  /** Bifrost team deleted (true even when it was already gone). */
  teamDeleted: boolean;
  /** K8s Secret holding the VK bearer token deleted (true when 404-tolerant). */
  tokenSecretDeleted: boolean;
  /** Orphan MCP clients removed by naming-convention sweep. */
  sweepMcpClientsRemoved: number;
  /** Orphan model-configs removed by naming-convention sweep. */
  sweepModelConfigsRemoved: number;
  /** Provider-key model bindings removed by naming-convention sweep. */
  sweepProviderBindingsRemoved: number;
  /** Project virtual keys removed by naming-convention sweep (incl. rotated). */
  sweepVirtualKeysRemoved: number;
  /** Project teams removed by naming-convention sweep. */
  sweepTeamsRemoved: number;
}

/**
 * Tear down ALL Bifrost-side state associated with an AgentStudio project,
 * in the safe order that mirrors create:
 *
 *   1. For each project model: `gateway.deleteModel(...)` -- removes the
 *      routing rule, the VK `provider_configs` entry, AND the entry in
 *      the shared `as-cred-{credentialId}` provider key's `models[]`
 *      list. The provider key itself is NOT deleted because it may be
 *      shared with other projects using the same credential.
 *
 *   2. For each project MCP server: `gateway.removeMCPServer(...)` --
 *      removes the Bifrost MCP client and the VK `mcp_configs` entry.
 *
 *   3. `deleteVirtualKey(virtualKeyId)` -- drops the per-project VK from
 *      Bifrost's `config_store`. 404-tolerant (treats already-deleted as
 *      success); steps 1+2 also already pruned it, so this is the final
 *      sweep.
 *
 *   4. `deleteTeam(teamId)` -- drops the per-project governance team.
 *      Also 404-tolerant.
 *
 *   5. `deleteProjectVirtualKeyTokenSecret(projectId)` -- drops the
 *      K8s Secret holding the VK bearer token (the data-plane handle
 *      consumed by agent-service). Already 404-tolerant.
 *
 * Each step is independently 404-tolerant and continues on per-item
 * failure: a slow / partially-broken Bifrost should not block project
 * deletion in config-service. The caller (DELETE /projects/:id) decides
 * whether to surface the returned counts to the user.
 *
 * The gateway client is injected to keep this module out of a circular
 * import with `BifrostGatewayClient` (which imports from here).
 *
 * Note: this does NOT delete the `models` / `mcp_servers` rows from the
 * config-service DB. Those table cleanups are the caller's responsibility
 * (the project-delete route handler iterates and removes them before
 * dropping the `projects` row).
 */
export async function teardownProjectGateway(
  projectId: string,
  gateway: ILLMGatewayClient,
  preloadedGateway?: PreloadedProjectGateway,
  axiosClient?: AxiosInstance,
): Promise<ProjectGatewayTeardownResult> {
  const result: ProjectGatewayTeardownResult = {
    modelsFound: 0,
    modelsRemoved: 0,
    modelsFailed: 0,
    mcpServersFound: 0,
    mcpServersRemoved: 0,
    mcpServersFailed: 0,
    virtualKeyDeleted: false,
    teamDeleted: false,
    tokenSecretDeleted: false,
    sweepMcpClientsRemoved: 0,
    sweepModelConfigsRemoved: 0,
    sweepProviderBindingsRemoved: 0,
    sweepVirtualKeysRemoved: 0,
    sweepTeamsRemoved: 0,
  };

  if (!gateway.isEnabled()) {
    console.log(
      `[bifrostProjectGovernance] teardown skipped for project ${safeLog(projectId)}: LLM gateway not configured`,
    );
    try {
      await deleteProjectVirtualKeyTokenSecret(projectId);
      result.tokenSecretDeleted = true;
    } catch (err: any) {
      console.warn(
        `[bifrostProjectGovernance] teardown: token Secret delete failed for project ${safeLog(projectId)}: ${safeLog(err?.message || err)}`,
      );
    }
    return result;
  }

  // Step 1: project models. Use the same per-model deletion path as
  // `DELETE /models/:id` so provider-key models[] is properly pruned.
  try {
    const models = await AppDataSource.getRepository(Model).find({ where: { projectId } });
    result.modelsFound = models.length;
    for (const model of models) {
      const gatewayMeta = model.rateCardOverride?._gateway as
        | {
            gatewayProvider?: string;
            keyName?: string;
            credentialId?: string;
          }
        | undefined;
      const deleteCredentialId = gatewayMeta?.credentialId || model.credentialId;
      let currentApiKey: string | undefined;
      if (deleteCredentialId) {
        currentApiKey = await readCredentialApiKey(projectId, deleteCredentialId);
      }
      try {
        await gateway.deleteModel(model.id, {
          gatewayProvider: gatewayMeta?.gatewayProvider,
          keyName: gatewayMeta?.keyName,
          providerModelId: model.providerModelId || model.name,
          gatewayBindingName: model.gatewayBindingName,
          credentialId: deleteCredentialId,
          currentApiKey,
          projectId,
          provider: model.provider,
        });
        result.modelsRemoved += 1;
      } catch (err: any) {
        result.modelsFailed += 1;
        console.warn(
          `[bifrostProjectGovernance] teardown: deleteModel failed for ${safeLog(model.id)} (project ${safeLog(projectId)}): ${safeLog(err?.message || err)}`,
        );
      }
    }
  } catch (err: any) {
    console.error(
      `[bifrostProjectGovernance] teardown: failed to enumerate models for project ${safeLog(projectId)}: ${safeLog(err?.message || err)}`,
    );
  }

  // Step 2: project MCP servers.
  try {
    const servers = await AppDataSource.getRepository(MCPServer).find({ where: { projectId } });
    result.mcpServersFound = servers.length;
    const bifrostClient = axiosClient || createBifrostClient();
    let bifrostMcpIndex: Map<string, string> | undefined;
    for (const server of servers) {
      const clientName =
        server.llmproxyGatewayServerName || `${projectId}_${server.name}`;
      let serverId = server.llmproxyGatewayServerId;
      if (!serverId) {
        if (!bifrostMcpIndex) {
          bifrostMcpIndex = new Map();
          const rows = await fetchBifrostMcpClients(bifrostClient);
          for (const raw of rows) {
            const entry = parseBifrostMcpListEntry(raw);
            if (entry?.server_name) {
              bifrostMcpIndex.set(entry.server_name, entry.server_id);
            }
          }
        }
        serverId = bifrostMcpIndex.get(clientName) || clientName;
      }
      try {
        await gateway.removeMCPServer(serverId, {
          projectId,
          mcpClientName: clientName,
        });
        result.mcpServersRemoved += 1;
      } catch (err: any) {
        result.mcpServersFailed += 1;
        console.warn(
          `[bifrostProjectGovernance] teardown: removeMCPServer failed for ${safeLog(server.id)} (project ${safeLog(projectId)}): ${safeLog(err?.message || err)}`,
        );
      }
    }
  } catch (err: any) {
    console.error(
      `[bifrostProjectGovernance] teardown: failed to enumerate MCP servers for project ${safeLog(projectId)}: ${safeLog(err?.message || err)}`,
    );
  }

  // Resolve the gateway ids to delete. We prefer the values that were
  // captured by the DELETE-route handler and passed in via
  // `preloadedGateway`, because by the time this runs as part of
  // `ProjectDeleteWorkflow` (Step 0 → `TeardownProjectLLMGatewayActivity`
  // → POST /api/v1/internal/projects/:projectId/gateway-teardown) the
  // project row may already be gone from config-service Postgres -- the
  // handler returns 204 immediately after kicking the workflow off. Fall
  // back to reading `projects.metadata._gateway` only when nothing was
  // preloaded (legacy inline-call path) or when the preloaded payload
  // lacks both ids. If neither source has the cache (project never had
  // governance set up, e.g. very old projects), we skip steps 3/4 and
  // only do the Secret cleanup.
  let cached: ProjectBifrostGateway | undefined;
  if (preloadedGateway && (preloadedGateway.teamId || preloadedGateway.virtualKeyId)) {
    cached = {
      teamId: preloadedGateway.teamId ?? undefined,
      teamName: preloadedGateway.teamName ?? undefined,
      virtualKeyId: preloadedGateway.virtualKeyId ?? undefined,
      virtualKeyName: preloadedGateway.virtualKeyName ?? undefined,
    } as ProjectBifrostGateway;
  } else {
    const project = await AppDataSource.getRepository(Project).findOneBy({ id: projectId });
    cached = project?.metadata?._gateway as ProjectBifrostGateway | undefined;
  }

  // Step 3: delete the project virtual key from Bifrost. 404-tolerant.
  if (cached?.virtualKeyId) {
    try {
      await deleteVirtualKey(cached.virtualKeyId, axiosClient);
      result.virtualKeyDeleted = true;
      console.log(
        `[bifrostProjectGovernance] teardown: deleted virtual key ${safeLog(cached.virtualKeyId)} for project ${safeLog(projectId)}`,
      );
    } catch (err: any) {
      if (err?.response?.status === 404) {
        result.virtualKeyDeleted = true;
      } else {
        console.warn(
          `[bifrostProjectGovernance] teardown: deleteVirtualKey failed for ${safeLog(cached.virtualKeyId)} (project ${safeLog(projectId)}): ${safeLog(err?.message || err)}`,
        );
      }
    }
  }

  // Step 4: delete the project team from Bifrost. Already 404-tolerant.
  if (cached?.teamId) {
    try {
      await deleteTeam(cached.teamId, axiosClient);
      result.teamDeleted = true;
      console.log(
        `[bifrostProjectGovernance] teardown: deleted team ${safeLog(cached.teamId)} for project ${safeLog(projectId)}`,
      );
    } catch (err: any) {
      if (err?.response?.status !== 404) {
        safeConsoleWarn(
          '[bifrostProjectGovernance] teardown: deleteTeam failed',
          cached.teamId,
          projectId,
          err?.message || err,
        );
      } else {
        result.teamDeleted = true;
      }
    }
  }

  // Step 5: naming-convention sweep for anything the DB-driven path missed
  // (orphaned MCP clients, model-configs, provider bindings, rotated VKs).
  const sweep = await sweepBifrostProjectOrphans(projectId, gateway, axiosClient);
  result.sweepMcpClientsRemoved = sweep.mcpClientsRemoved;
  result.sweepModelConfigsRemoved = sweep.modelConfigsRemoved;
  result.sweepProviderBindingsRemoved = sweep.providerBindingsRemoved;
  result.sweepVirtualKeysRemoved = sweep.virtualKeysRemoved;
  result.sweepTeamsRemoved = sweep.teamsRemoved;
  if (sweep.virtualKeysRemoved > 0) result.virtualKeyDeleted = true;
  if (sweep.teamsRemoved > 0) result.teamDeleted = true;

  // Step 6: delete the K8s Secret holding the VK bearer token.
  try {
    await deleteProjectVirtualKeyTokenSecret(projectId);
    result.tokenSecretDeleted = true;
  } catch (err: any) {
    console.warn(
      `[bifrostProjectGovernance] teardown: token Secret delete failed for project ${safeLog(projectId)}: ${safeLog(err?.message || err)}`,
    );
  }

  console.log(
    `[bifrostProjectGovernance] teardown summary for project ${safeLog(projectId)}: ` +
      `models=${result.modelsRemoved}/${result.modelsFound} (${result.modelsFailed} failed), ` +
      `mcp_servers=${result.mcpServersRemoved}/${result.mcpServersFound} (${result.mcpServersFailed} failed), ` +
      `vk=${result.virtualKeyDeleted}, team=${result.teamDeleted}, secret=${result.tokenSecretDeleted}, ` +
      `sweep(mcp=${result.sweepMcpClientsRemoved}, model_cfg=${result.sweepModelConfigsRemoved}, ` +
      `provider=${result.sweepProviderBindingsRemoved}, vk=${result.sweepVirtualKeysRemoved}, team=${result.sweepTeamsRemoved})`,
  );

  return result;
}
