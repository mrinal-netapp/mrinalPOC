import axios from 'axios';
import { get_logger } from '@agentstudio/observability-client-runtime';

const logger = get_logger();

/**
 * Default (list) pricing for provider models, mirroring the Bifrost Model
 * Catalog datasheet (`https://getbifrost.ai/datasheet`, LiteLLM format). Bifrost
 * itself uses this data to compute request cost; we surface the same numbers in
 * the Add-model UI so users see a model's list price per 1M tokens before they
 * register it (and can pre-fill their own overrides from it).
 *
 * Two sources, in priority order:
 *   1. The live datasheet (`MODEL_PRICING_DATASHEET_URL`, default the Bifrost
 *      datasheet URL) — refreshed lazily in the background so the endpoint never
 *      blocks on network I/O. This keeps prices current wherever egress works.
 *   2. A curated embedded subset (below) — the deterministic, offline fallback
 *      used before the first refresh completes or when egress is unavailable
 *      (e.g. locked-down clusters, which is also why Bifrost ships a bundled
 *      copy). Covers the common models across the mainstream providers.
 *
 * All costs are stored in the datasheet's native per-token unit; callers get
 * per-1M values (per-token × 1e6).
 */

/** A single datasheet row (subset of the fields Bifrost/LiteLLM publish). */
export type PricingDatasheetEntry = {
  provider?: string;
  /** e.g. `chat`, `embedding`, `completion`. */
  mode?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
};

export type PricingDatasheet = Record<string, PricingDatasheetEntry>;

/** Resolved default pricing for a (provider, model), in per-1M-token USD. */
export type ModelPricingDefault = {
  provider: string;
  model: string;
  currency: 'USD';
  /** USD per 1M input (prompt) tokens, or null when the datasheet omits it. */
  inputCostPer1M: number | null;
  /** USD per 1M output (completion) tokens, or null when omitted. */
  outputCostPer1M: number | null;
  mode?: string;
  /** Which source answered: the live datasheet or the embedded fallback. */
  source: 'datasheet' | 'builtin';
  /**
   * The catalog id that actually answered. Differs from `model` when the query
   * was resolved by normalization / prefix match (e.g. an Azure deployment name
   * or a dated snapshot mapped onto its canonical family id).
   */
  matchedModel?: string;
  /**
   * True when the price came from a normalized / prefix match rather than an
   * exact id hit — i.e. it is the closest catalog family price, not guaranteed
   * to be the exact SKU. Callers may surface this as an "approximate" hint.
   */
  approximate?: boolean;
};

const PER_MILLION = 1_000_000;

/** Build a per-token entry from readable per-1M USD figures. */
function perMillion(
  provider: string,
  mode: string,
  inputPer1M: number,
  outputPer1M: number,
): PricingDatasheetEntry {
  return {
    provider,
    mode,
    input_cost_per_token: inputPer1M / PER_MILLION,
    output_cost_per_token: outputPer1M / PER_MILLION,
  };
}

/**
 * Curated fallback datasheet. Keys are model ids as providers expose them
 * (matching how Bifrost keys the upstream sheet). Values reflect public list
 * prices at time of writing — the live datasheet supersedes these when
 * reachable, so this only needs to be "good enough" for offline display.
 */
export const EMBEDDED_PRICING_DATASHEET: PricingDatasheet = {
  // ── OpenAI (Azure OpenAI shares these model ids) ──
  'gpt-4o': perMillion('openai', 'chat', 2.5, 10),
  'gpt-4o-mini': perMillion('openai', 'chat', 0.15, 0.6),
  'gpt-4.1': perMillion('openai', 'chat', 2, 8),
  'gpt-4.1-mini': perMillion('openai', 'chat', 0.4, 1.6),
  'gpt-4.1-nano': perMillion('openai', 'chat', 0.1, 0.4),
  'gpt-4-turbo': perMillion('openai', 'chat', 10, 30),
  'gpt-3.5-turbo': perMillion('openai', 'chat', 0.5, 1.5),
  o3: perMillion('openai', 'chat', 2, 8),
  'o4-mini': perMillion('openai', 'chat', 1.1, 4.4),
  'text-embedding-3-small': perMillion('openai', 'embedding', 0.02, 0),
  'text-embedding-3-large': perMillion('openai', 'embedding', 0.13, 0),
  // ── Anthropic ──
  'claude-3-5-sonnet': perMillion('anthropic', 'chat', 3, 15),
  'claude-3-5-sonnet-latest': perMillion('anthropic', 'chat', 3, 15),
  'claude-3-5-haiku': perMillion('anthropic', 'chat', 0.8, 4),
  'claude-3-opus': perMillion('anthropic', 'chat', 15, 75),
  'claude-sonnet-4': perMillion('anthropic', 'chat', 3, 15),
  // ── Google (Vertex / Gemini) ──
  'gemini-1.5-pro': perMillion('vertex_ai', 'chat', 1.25, 5),
  'gemini-1.5-flash': perMillion('vertex_ai', 'chat', 0.075, 0.3),
  'gemini-2.0-flash': perMillion('vertex_ai', 'chat', 0.1, 0.4),
  // ── Mistral ──
  'mistral-large-latest': perMillion('mistral', 'chat', 2, 6),
  'mistral-small-latest': perMillion('mistral', 'chat', 0.2, 0.6),
  // ── Groq ──
  'llama-3.3-70b-versatile': perMillion('groq', 'chat', 0.59, 0.79),
  // ── Cohere ──
  'command-r': perMillion('cohere', 'chat', 0.15, 0.6),
  'command-r-plus': perMillion('cohere', 'chat', 2.5, 10),
};

/**
 * Map a config-service provider id onto the datasheet's provider naming so a
 * bare model id can be disambiguated when it appears under multiple providers.
 */
export function mapProviderToDatasheet(provider: string | undefined | null): string | null {
  if (!provider) return null;
  switch (provider.toLowerCase()) {
    case 'openai':
    case 'openai_compatible':
      return 'openai';
    case 'azure':
    case 'azure-openai':
    case 'azure_openai':
      return 'azure';
    case 'aws_bedrock':
    case 'bedrock':
      return 'bedrock';
    case 'google':
    case 'vertex':
    case 'vertex_ai':
      return 'vertex_ai';
    case 'gemini':
      return 'gemini';
    case 'anthropic':
      return 'anthropic';
    case 'mistral':
      return 'mistral';
    case 'groq':
      return 'groq';
    case 'cohere':
      return 'cohere';
    default:
      return provider.toLowerCase();
  }
}

/** Round to 4 decimals, avoiding `-0` and float dust from the ×1e6 scale-up. */
function toPer1M(costPerToken: number | undefined): number | null {
  if (typeof costPerToken !== 'number' || !Number.isFinite(costPerToken)) return null;
  const scaled = costPerToken * PER_MILLION;
  const rounded = Math.round(scaled * 10_000) / 10_000;
  return rounded === 0 ? 0 : rounded;
}

/** Strip any leading `provider/` segment from a datasheet key or model id. */
function bareId(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
}

/**
 * Loose form for prefix comparison: dots removed so provider spellings like
 * Azure's `gpt-35-turbo` line up with the catalog's `gpt-3.5-turbo`.
 */
function looseId(id: string): string {
  return id.replace(/\./g, '');
}

/** True when `id` starts with `key` at a token boundary (or equals it). */
function isTokenPrefix(id: string, key: string): boolean {
  if (!key || key.length > id.length) return false;
  if (!id.startsWith(key)) return false;
  if (id.length === key.length) return true;
  // Next char must be a separator so `gpt-4` can't swallow `gpt-4o`.
  return /[^a-z0-9]/.test(id.charAt(key.length));
}

/**
 * Longest catalog key that is a token-boundary prefix of `bareModelId`,
 * comparing each key by its bare id (portion after any `provider/`). Prefers
 * entries whose declared provider matches `wanted`, then longer (more specific)
 * keys. Handles decorated ids — Azure deployment names, dated snapshots
 * (`-2024-08-06`), `-preview`, version suffixes — without enumerating them.
 */
function longestPrefixMatch(
  index: Map<string, { key: string; entry: PricingDatasheetEntry }>,
  bareModelId: string,
  wanted: string | null,
): { key: string; entry: PricingDatasheetEntry } | null {
  const target = looseId(bareModelId);
  let best: { key: string; entry: PricingDatasheetEntry } | null = null;
  let bestScore = -1;
  for (const hit of index.values()) {
    const bareKey = looseId(bareId(hit.key.toLowerCase()));
    if (!isTokenPrefix(target, bareKey)) continue;
    const providerMatch =
      wanted != null && hit.entry.provider != null && hit.entry.provider.toLowerCase() === wanted;
    // Provider match dominates; among equals, the longer key is more specific.
    const score = bareKey.length + (providerMatch ? 10_000 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = hit;
    }
  }
  return best;
}

/**
 * Look up a (provider, model) in a datasheet. Pure — takes the sheet explicitly
 * so it is trivially testable.
 *
 * Resolution order:
 *   1. Exact id, provider-preferred: try `provider/model` then the bare id,
 *      preferring an entry whose `provider` matches when a bare id is shared.
 *   2. Normalized / longest-prefix fallback (`approximate: true`): real provider
 *      model ids are decorated (Azure deployment names, dated OpenAI snapshots,
 *      `-preview`, version suffixes) and rarely equal a canonical catalog key,
 *      so we map onto the closest catalog family price.
 */
export function lookupPricingInSheet(
  sheet: PricingDatasheet,
  provider: string,
  model: string,
  source: ModelPricingDefault['source'],
): ModelPricingDefault | null {
  const modelId = (model ?? '').trim().toLowerCase();
  if (!modelId) return null;

  // Case-insensitive index of the sheet keyed by lowercased id.
  const index = new Map<string, { key: string; entry: PricingDatasheetEntry }>();
  for (const [key, entry] of Object.entries(sheet)) {
    index.set(key.toLowerCase(), { key, entry });
  }

  const wanted = mapProviderToDatasheet(provider);
  const bareModelId = bareId(modelId);

  // 1) Exact match, provider-preferred.
  const exactKeys = [
    wanted ? `${wanted}/${bareModelId}` : null,
    wanted ? `${wanted}/${modelId}` : null,
    bareModelId,
    modelId,
  ].filter((k): k is string => k != null);

  let match: { key: string; entry: PricingDatasheetEntry } | null = null;
  let weak: { key: string; entry: PricingDatasheetEntry } | null = null;
  for (const key of exactKeys) {
    const hit = index.get(key);
    if (!hit) continue;
    // For a bare-id key, prefer a provider match when the entry declares one;
    // remember the mismatch as a weak fallback and keep looking.
    if (
      !key.includes('/') &&
      wanted &&
      hit.entry.provider &&
      hit.entry.provider.toLowerCase() !== wanted
    ) {
      weak = weak ?? hit;
      continue;
    }
    match = hit;
    break;
  }
  if (!match) match = weak;

  // 2) Normalized / longest-prefix fallback for decorated ids.
  let approximate = false;
  if (!match) {
    match = longestPrefixMatch(index, bareModelId, wanted);
    approximate = match != null;
  }

  if (!match) return null;

  const inputCostPer1M = toPer1M(match.entry.input_cost_per_token);
  const outputCostPer1M = toPer1M(match.entry.output_cost_per_token);
  if (inputCostPer1M == null && outputCostPer1M == null) return null;

  return {
    provider,
    model,
    currency: 'USD',
    inputCostPer1M,
    outputCostPer1M,
    mode: match.entry.mode,
    source,
    matchedModel: match.key,
    approximate,
  };
}

// ── Live datasheet cache (lazy, non-blocking background refresh) ──

const DATASHEET_TTL_MS = 24 * 60 * 60 * 1000; // matches Bifrost's 24h sync
const DATASHEET_FETCH_TIMEOUT_MS = Number(
  process.env.MODEL_PRICING_DATASHEET_TIMEOUT_MS ?? '5000',
);

let remoteSheet: PricingDatasheet | null = null;
let remoteLoadedAt = 0;
let remoteInFlight: Promise<void> | null = null;

/** Resolve the datasheet URL, or null when live refresh is disabled. */
function datasheetUrl(): string | null {
  // Skip network in tests for determinism.
  if (process.env.NODE_ENV === 'test') return null;
  const raw = process.env.MODEL_PRICING_DATASHEET_URL ?? 'https://getbifrost.ai/datasheet';
  const url = raw.trim();
  if (!url || url.toLowerCase() === 'off' || url.toLowerCase() === 'false') return null;
  return url;
}

/**
 * Kick off a background refresh of the live datasheet when it is stale. Never
 * throws and never blocks the caller: the current request is answered from
 * whatever is already cached (embedded until the first refresh lands).
 */
function ensureDatasheetFresh(): void {
  const url = datasheetUrl();
  if (!url) return;
  if (remoteInFlight) return;
  if (remoteSheet && Date.now() - remoteLoadedAt < DATASHEET_TTL_MS) return;

  remoteInFlight = axios
    .get(url, { timeout: DATASHEET_FETCH_TIMEOUT_MS })
    .then((resp) => {
      if (resp.data && typeof resp.data === 'object') {
        remoteSheet = resp.data as PricingDatasheet;
        remoteLoadedAt = Date.now();
        logger.info(
          `[modelPricingCatalog] loaded ${Object.keys(remoteSheet).length} pricing entries from datasheet`,
        );
      }
    })
    .catch((err) => {
      logger.warn(
        `[modelPricingCatalog] datasheet refresh failed, using embedded pricing: ${
          (err as Error).message
        }`,
      );
    })
    .finally(() => {
      remoteInFlight = null;
    });
}

/**
 * Ensure the live datasheet has had a chance to load. On the very first call
 * (nothing cached yet) this awaits the in-flight fetch up to `maxWaitMs`, so the
 * first user request gets live prices instead of the embedded subset — the
 * embedded set is a small curated fallback and omits newer models (e.g. the
 * gpt-5 family), which is exactly the case where blocking briefly matters. Once
 * a sheet is cached it returns immediately and TTL refreshes stay in the
 * background.
 */
async function ensureDatasheetReady(
  maxWaitMs = DATASHEET_FETCH_TIMEOUT_MS + 500,
): Promise<void> {
  ensureDatasheetFresh();
  if (remoteSheet) return; // already have data — never block on a refresh
  const inFlight = remoteInFlight;
  if (!inFlight) return; // live refresh disabled or unavailable
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, maxWaitMs);
  });
  try {
    await Promise.race([inFlight, bounded]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolve default (list) pricing for a provider model. Prefers the live Bifrost
 * datasheet (awaiting its first load so newly-released models resolve on the
 * first request), and falls back to the embedded subset when the datasheet has
 * no entry or is unreachable.
 */
export async function getModelPricingDefault(
  provider: string,
  model: string,
): Promise<ModelPricingDefault | null> {
  await ensureDatasheetReady();
  if (remoteSheet) {
    const live = lookupPricingInSheet(remoteSheet, provider, model, 'datasheet');
    if (live) return live;
  }
  return lookupPricingInSheet(EMBEDDED_PRICING_DATASHEET, provider, model, 'builtin');
}

/** Test seam: reset the live datasheet cache. */
export function __resetPricingDatasheetCacheForTests(): void {
  remoteSheet = null;
  remoteLoadedAt = 0;
  remoteInFlight = null;
}

// Warm the live datasheet at import time so the first real request rarely has
// to wait. No-op when live refresh is disabled (tests / `MODEL_PRICING_DATASHEET_URL=off`).
ensureDatasheetFresh();
