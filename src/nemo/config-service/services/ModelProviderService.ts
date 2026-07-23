/**
 * Service for the project providers overview.
 *
 * The set of providers a project has "configured" is derived live from the
 * data the user actually populates — the `credentials` and `models` tables —
 * so a provider appears in the overview as soon as its first credential is
 * saved (or a model is registered), with no separate write path to keep in
 * sync. Only LLM/model providers that can be configured on the Bifrost gateway
 * are surfaced: data-source connector credentials (GCNV/GCP, ONTAP, S3, GCS,
 * Azure cloud, PostgreSQL, MySQL, Redash) live in the same `credentials` table
 * but never reach Bifrost, so they are filtered out of this overview (see
 * `selectOverviewProviderIds`). The `model_providers` table is used only as a
 * health cache: it stores
 * the connectionStatus/statusMessage/concurrency/bufferSize derived from
 * Bifrost so reads don't need a gateway hop. Operations:
 *   - `listProjectProviders(projectId)` — union of (credentials ∪ models ∪
 *     cached rows), merged with the cached health row when present.
 *   - `refreshProjectProvidersFromBifrost(projectId)` — explicit user action
 *     (the UI Refresh button). Pulls live state from Bifrost and persists
 *     connectionStatus + statusMessage into the cache for Bifrost-known
 *     providers.
 *   - `upsertProvider(...)` — optimistic cache seed for the model-registration
 *     write path to call after it has successfully written to Bifrost.
 */
import { AppDataSource } from '../db/postgres';
import { Credential } from '../models/Credential';
import { Model } from '../models/Model';
import { ModelProvider, ProviderConnectionStatus } from '../models/ModelProvider';
import {
  listGatewayProviders,
  listProviderKeys,
  mapLlmProviderToBifrost,
  updateProviderProxyOnGateway,
} from './bifrost/bifrostProviderOps';
import { getLLMGatewayClient } from './gatewayClient';
import { getProviderRegistry } from '../providers/registry';
import { connectorProviderIds } from '../providers/connector';
import { safeConsoleWarn } from '../utils/safeStrings';

/** Operator-facing display names surfaced in the Providers overview table. */
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  openai_compatible: 'OpenAI-compatible',
  aws_bedrock: 'AWS Bedrock',
  azure: 'Azure OpenAI',
  google: 'Google Vertex AI',
  gemini: 'Google Gemini',
  anthropic: 'Anthropic',
  ollama: 'Ollama',
  cohere: 'Cohere',
  perplexity: 'Perplexity',
  huggingface: 'Hugging Face',
  fireworks: 'Fireworks AI',
};

export function providerDisplayName(providerId: string): string {
  return PROVIDER_DISPLAY_NAMES[providerId] ?? providerId;
}

// Defaults mirror the Bifrost provider PUT (concurrency_and_buffer_size).
const DEFAULT_PROVIDER_CONCURRENCY = 1000;
const DEFAULT_PROVIDER_BUFFER_SIZE = 5000;

export interface UpsertProviderInput {
  projectId: string;
  /** AgentStudio-side provider id (e.g. `openai`, `azure`). Bifrost mapping is applied at refresh time. */
  providerId: string;
  name: string;
  concurrency: number;
  bufferSize: number;
  connectionStatus?: ProviderConnectionStatus;
  statusMessage?: string | null;
}

function repo() {
  return AppDataSource.getRepository(ModelProvider);
}

/**
 * The set of LLM/model provider ids that can be configured on the Bifrost
 * gateway (registry adapters minus the data-source connector adapters).
 * Derived from the registry so a newly-added LLM adapter shows up
 * automatically and any new connector is excluded automatically.
 */
function llmProviderIdSet(): Set<string> {
  const connectors = connectorProviderIds();
  return new Set(
    getProviderRegistry()
      .listProviders()
      .filter((id) => !connectors.has(id)),
  );
}

/**
 * Compute the provider ids to surface in the Models > Providers overview.
 *
 * Pure (no DB / gateway access) so it is unit-testable. Rules:
 *  - Credential-derived providers are included ONLY when they are LLM/Bifrost
 *    providers. Data-source connector credentials (GCNV/GCP, ONTAP, S3, ...)
 *    and any unknown provider string are dropped — they are never registered
 *    on Bifrost and must not appear as model providers.
 *  - Providers that have a registered model, or an existing health-cache row,
 *    are always included: both signals mean the provider is wired into Bifrost.
 *
 * Returns a sorted, de-duplicated array.
 */
export function selectOverviewProviderIds(
  credentialProviders: Iterable<string>,
  modelProviders: Iterable<string>,
  cachedProviderIds: Iterable<string>,
): string[] {
  const llmProviders = llmProviderIdSet();
  const ids = new Set<string>();
  for (const raw of credentialProviders) {
    const id = (raw ?? '').trim();
    if (id && llmProviders.has(id)) ids.add(id);
  }
  for (const raw of modelProviders) {
    const id = (raw ?? '').trim();
    if (id) ids.add(id);
  }
  for (const raw of cachedProviderIds) {
    const id = (raw ?? '').trim();
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

export async function listProjectProviders(projectId: string): Promise<ModelProvider[]> {
  const credRepo = AppDataSource.getRepository(Credential);
  const modelRepo = AppDataSource.getRepository(Model);

  const [credRows, modelRows, cachedRows] = await Promise.all([
    credRepo.find({ where: { projectId }, select: ['provider'] }),
    modelRepo.find({ where: { projectId }, select: ['provider'] }),
    repo().find({ where: { projectId } }),
  ]);

  // Cached health rows (connectionStatus/statusMessage/concurrency/bufferSize).
  const cacheByProvider = new Map<string, ModelProvider>();
  for (const row of cachedRows) cacheByProvider.set(row.providerId, row);

  // Providers backed by at least one registered model — these are wired into
  // Bifrost, so a creds-only provider (no model yet) can be surfaced as such.
  const modelProviderIds = new Set(
    modelRows.map((m) => (m.provider ?? '').trim()).filter(Boolean),
  );

  // Only LLM/Bifrost providers are surfaced; connector (data-source) credentials
  // such as GCNV/GCP are excluded (see selectOverviewProviderIds).
  const providerIds = selectOverviewProviderIds(
    credRows.map((c) => c.provider ?? ''),
    modelRows.map((m) => m.provider ?? ''),
    [...cacheByProvider.keys()],
  );

  const result: ModelProvider[] = [];
  for (const providerId of providerIds) {
    const cached = cacheByProvider.get(providerId);
    if (cached) {
      result.push(cached);
      continue;
    }
    // No cached health row yet — build a transient view. A provider with a
    // saved credential but no registered model isn't wired into Bifrost yet,
    // so say so rather than implying a live connection.
    const hasModel = modelProviderIds.has(providerId);
    result.push(
      repo().create({
        projectId,
        providerId,
        name: providerDisplayName(providerId),
        concurrency: DEFAULT_PROVIDER_CONCURRENCY,
        bufferSize: DEFAULT_PROVIDER_BUFFER_SIZE,
        connectionStatus: 'disconnected',
        statusMessage: hasModel ? null : 'No models registered yet',
      }),
    );
  }
  return result;
}

interface BifrostProviderKey {
  status?: unknown;
  enabled?: unknown;
}

interface BifrostProviderEntry {
  name?: string;
  keys?: BifrostProviderKey[];
}

/**
 * Bifrost reports each provider key's last validation result on `key.status`.
 * A validated/working key comes back as `"success"` (other gateway builds use
 * ok/active/ready/healthy synonyms). Anything outside this set — an empty
 * string aside — is treated as an upstream auth/connectivity failure and its
 * text is surfaced as the statusMessage.
 */
const HEALTHY_KEY_STATUSES = new Set([
  'ok',
  'active',
  'ready',
  'success',
  'healthy',
  'connected',
  'valid',
  'pass',
  'passed',
  'online',
  'up',
  'enabled',
]);

/**
 * Derive (connectionStatus, statusMessage) for one project row given the
 * matching Bifrost provider entry (or undefined if Bifrost has no entry).
 */
function deriveConnection(
  bifrostEntry: BifrostProviderEntry | undefined,
): { connectionStatus: ProviderConnectionStatus; statusMessage: string | null } {
  if (!bifrostEntry) {
    return { connectionStatus: 'disconnected', statusMessage: null };
  }
  const keys = Array.isArray(bifrostEntry.keys) ? bifrostEntry.keys : [];
  if (keys.length === 0) {
    return { connectionStatus: 'degraded', statusMessage: 'Provider has no keys configured' };
  }

  let firstErrorMessage: string | null = null;
  let healthyCount = 0;
  for (const key of keys) {
    const statusText = typeof key.status === 'string' ? key.status.trim() : '';
    const isHealthy = statusText === '' || HEALTHY_KEY_STATUSES.has(statusText.toLowerCase());
    if (isHealthy) {
      healthyCount++;
    } else if (firstErrorMessage === null) {
      firstErrorMessage = statusText;
    }
  }

  if (healthyCount === keys.length) {
    return { connectionStatus: 'connected', statusMessage: null };
  }
  if (healthyCount > 0) {
    return { connectionStatus: 'degraded', statusMessage: firstErrorMessage };
  }
  return { connectionStatus: 'error', statusMessage: firstErrorMessage };
}

export async function refreshProjectProvidersFromBifrost(
  projectId: string,
): Promise<ModelProvider[]> {
  const rows = await listProjectProviders(projectId);
  if (rows.length === 0) return rows;

  if (!getLLMGatewayClient().isEnabled()) {
    safeConsoleWarn(
      '[ModelProviderService] LLM gateway is not configured; skipping refresh for project',
      projectId,
    );
    return rows;
  }

  let bifrostProviders: BifrostProviderEntry[] = [];
  try {
    const resp = await listGatewayProviders();
    bifrostProviders = (resp.providers as BifrostProviderEntry[]) || [];
  } catch (err: any) {
    safeConsoleWarn(
      '[ModelProviderService] listGatewayProviders failed for project',
      projectId,
      err?.message || err,
    );
    return rows;
  }

  const byName = new Map<string, BifrostProviderEntry>();
  for (const p of bifrostProviders) {
    if (p?.name) byName.set(String(p.name), p);
  }

  const changed: ModelProvider[] = [];
  for (const row of rows) {
    const bifrostName = mapLlmProviderToBifrost(row.providerId);
    const entry = byName.get(bifrostName);
    // Not registered in Bifrost (e.g. credential saved but no model yet):
    // leave the derived "No models registered yet" view untouched and don't
    // persist a misleading disconnected health row.
    if (!entry) continue;

    // Bifrost v1.5 no longer embeds `keys[]` on the provider object returned
    // by `GET /api/providers`; the keys live on the dedicated subresource
    // (`GET /api/providers/{provider}/keys`). Without fetching them here the
    // health derivation always sees zero keys and reports every provider (and
    // its models) as "degraded — Provider has no keys configured", even when
    // the underlying credential is healthy. Pull the real keys so the status
    // reflects Bifrost's actual per-key validation result.
    if (!Array.isArray(entry.keys)) {
      try {
        entry.keys = (await listProviderKeys(bifrostName)) as BifrostProviderKey[];
      } catch (err: any) {
        safeConsoleWarn(
          '[ModelProviderService] listProviderKeys failed for provider',
          bifrostName,
          err?.message || err,
        );
        continue;
      }
    }

    const { connectionStatus, statusMessage } = deriveConnection(entry);
    if (
      row.connectionStatus !== connectionStatus ||
      (row.statusMessage ?? null) !== statusMessage
    ) {
      row.connectionStatus = connectionStatus;
      row.statusMessage = statusMessage;
      changed.push(row);
    }
  }

  // Persist the Bifrost-derived health. `changed` may include transient rows
  // (providers wired into Bifrost that have no cache row yet) — save() inserts
  // those, turning the overview's live derivation into a warm cache.
  if (changed.length > 0) {
    await repo().save(changed);
  }

  return rows;
}

/**
 * Update a provider's proxy tuning (concurrency + buffer size) from the
 * Providers overview "Edit" action. The `model_providers` cache is the source
 * of truth for these values (they are never refreshed from Bifrost), so we
 * persist there and best-effort push the same values to the Bifrost gateway so
 * runtime routing matches. A gateway failure (or a provider not yet registered
 * on Bifrost) is logged but does not block persisting the operator's intent.
 */
export async function updateProviderProxyConfig(
  projectId: string,
  providerId: string,
  concurrency: number,
  bufferSize: number,
): Promise<ModelProvider> {
  const existing = await repo().findOne({ where: { projectId, providerId } });

  // `openai_compatible` maps to a per-credential Bifrost provider name
  // (`as-openai-compat-<short>`) that can't be resolved from the provider id
  // alone, so skip the gateway push for it — the cache write below still
  // records the operator's chosen values for the overview.
  if (providerId !== 'openai_compatible' && getLLMGatewayClient().isEnabled()) {
    try {
      await updateProviderProxyOnGateway(
        mapLlmProviderToBifrost(providerId),
        concurrency,
        bufferSize,
      );
    } catch (err: any) {
      safeConsoleWarn(
        '[ModelProviderService] proxy-config gateway update failed for provider',
        providerId,
        err?.message || err,
      );
    }
  }

  return upsertProvider({
    projectId,
    providerId,
    name: existing?.name ?? providerDisplayName(providerId),
    concurrency,
    bufferSize,
    // Preserve any Bifrost-derived health already on the row; a brand-new row
    // falls back to upsertProvider's defaults.
    connectionStatus: existing?.connectionStatus,
    statusMessage: existing?.statusMessage,
  });
}

export async function upsertProvider(input: UpsertProviderInput): Promise<ModelProvider> {
  const r = repo();
  const existing = await r.findOne({
    where: { projectId: input.projectId, providerId: input.providerId },
  });
  if (existing) {
    existing.name = input.name;
    existing.concurrency = input.concurrency;
    existing.bufferSize = input.bufferSize;
    if (input.connectionStatus !== undefined) existing.connectionStatus = input.connectionStatus;
    if (input.statusMessage !== undefined) existing.statusMessage = input.statusMessage;
    return r.save(existing);
  }
  const row = r.create({
    projectId: input.projectId,
    providerId: input.providerId,
    name: input.name,
    concurrency: input.concurrency,
    bufferSize: input.bufferSize,
    connectionStatus: input.connectionStatus ?? 'connected',
    statusMessage: input.statusMessage ?? null,
  });
  return r.save(row);
}
