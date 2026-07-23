/**
 * Bifrost provider/key operations (ported from Nemo model-service onboarding).
 */
import axios, { AxiosInstance } from 'axios';
import { AZURE_OPENAI_DEFAULT_API_VERSION } from '../../providers/azure';
import { resolveGatewayApiKey, resolveGatewayBaseUrl } from '../gatewayClient';
import { safeConsoleWarn, safeLog } from '../../utils/safeStrings';

/**
 * Strict regex sanitizer for keys we use as property names in objects
 * we build from caller-supplied data (e.g. a Bifrost provider deployment-routing
 * map). Must start with a letter so reserved JS names that start with
 * `_` (e.g. `__proto__`) are rejected, and the allowed character set
 * (letters, digits, dash, underscore, dot) blocks shell / URL meta-
 * characters. The dot is required because real model ids are dotted
 * (e.g. `gpt-3.5-turbo`, `gpt-4.1`, `gpt-5.4`) and those names flow
 * into the binding name verbatim; a dot is harmless as an object
 * property name (it cannot reach the prototype chain). CodeQL
 * `js/remote-property-injection` recognises a `.test()` call against a
 * literal regex as a sanitizer for tainted property names.
x₹ */
const SAFE_DEPLOYMENT_KEY = /^[A-Za-z][A-Za-z0-9_.-]*$/;

function isSafeDeploymentKey(key: string): boolean {
  if (!SAFE_DEPLOYMENT_KEY.test(key)) return false;
  // Belt-and-suspenders: even if a key passes the regex (a letter then
  // alphanumerics / `_` / `-`), refuse the well-known prototype-
  // pollution targets that are valid identifiers. `__proto__` is
  // already excluded by the leading-letter requirement, but
  // `constructor` and `prototype` are not.
  if (key === 'constructor' || key === 'prototype' || key === '__proto__') {
    return false;
  }
  return true;
}

/**
 * Trim a single trailing `/v1` (if present) and any number of trailing
 * `/` characters from a user-provided base URL. Implemented as a
 * single-pass char walk rather than a regex because the regex form
 * (`/\/+$/`) is flagged by CodeQL as a polynomial pattern over
 * uncontrolled data — pathological inputs with long runs of trailing
 * slashes can degrade regex matching on some engines. The walk is
 * unconditionally linear.
 */
function stripV1AndTrailingSlashes(input: string): string {
  let end = input.length;
  while (end > 0 && input.charCodeAt(end - 1) === 47 /* '/' */) end--;
  let out = input.slice(0, end);
  if (out.endsWith('/v1')) out = out.slice(0, -3);
  return out;
}

/**
 * Map AgentStudio's LLM-provider vocabulary to Bifrost's. The two
 * disagree on a few names (e.g. AgentStudio `aws_bedrock` -> Bifrost
 * `bedrock`, AgentStudio `google` -> Bifrost `vertex`, AgentStudio
 * `local` -> Bifrost `ollama`), so we keep an explicit mapping table
 * and pass the original AgentStudio name around as `llmProvider`
 * until the moment we need to call Bifrost, when it becomes
 * `gatewayProvider` / `bifrostProvider`.
 */
const LLM_PROVIDER_TO_BIFROST: Record<string, string> = {
  openai: 'openai',
  // `openai_compatible` is intentionally NOT in this static table: its
  // Bifrost-side provider name is per-credential because Bifrost's
  // native `openai` provider has its base URL hardcoded (api.openai.com)
  // and ignores per-key `api_base`. We instead create a custom Bifrost
  // provider per credential (`as-openai-compat-<credShortId>`) with
  // `network_config.base_url` pointing at the user's endpoint and
  // `custom_provider_config.base_provider_type: 'openai'` so Bifrost
  // speaks OpenAI wire format to the upstream. See
  // `buildOpenAICompatibleProviderName` + `appendBuiltinProviderKey`.
  aws_bedrock: 'bedrock',
  azure: 'azure',
  // AgentStudio `google` == "Google Vertex AI" -> Bifrost's native `vertex`
  // provider, which authenticates with a service-account JSON scoped to a
  // `project_id` + `region` (see `vertex_key_config` in buildKeyPayload).
  google: 'vertex',
  // `gemini` is a separate first-class AgentStudio provider (Google AI Studio /
  // Gemini Developer API, plain API key) -> Bifrost's native `gemini` provider.
  // Keeping the two apart lets Vertex (service account) and the Gemini
  // Developer API (API key) coexist without one masquerading as the other.
  // `anthropic` is a native Bifrost provider (plain API key), so it maps
  // straight through.
  gemini: 'gemini',
  anthropic: 'anthropic',
  // `ollama` is a first-class provider rather than a generic "local"
  // bucket. The previous `local: 'ollama'` mapping was wrong for two
  // reasons: (a) it silently routed local **embedding** models (e.g.
  // sentence-transformers nomic-embed, all-MiniLM) to Ollama even
  // though Ollama doesn't typically serve those, and (b) non-Ollama
  // local LLM stacks (vLLM, TGI, llama.cpp) were being misrouted too.
  // A proper home for other local stacks (vLLM, sentence-transformers,
  // TEI, ...) is a follow-up; for now register them via
  // `openai_compatible` if they expose an OpenAI-compatible HTTP API.
  ollama: 'ollama',
  // Additional native Bifrost providers (plain API key). Their AgentStudio
  // keys match Bifrost's provider ids 1:1, so they'd pass through the
  // `|| provider` fallback below anyway; listing them explicitly keeps this
  // table the single documented source of truth for supported providers.
  cohere: 'cohere',
  perplexity: 'perplexity',
  huggingface: 'huggingface',
  fireworks: 'fireworks',
};

/**
 * Length of the credential-UUID prefix used to scope Bifrost-side
 * identifiers (`as-openai-compat-<short>` providers and project__cred__model
 * binding names). 12 hex chars → 48 bits, birthday-collision boundary
 * ~16M credentials per scope, comfortably above any realistic project
 * size while keeping the names short enough to scan in the Bifrost UI.
 * Centralised so both `buildOpenAICompatibleProviderName` and
 * `buildGatewayBindingName` stay in lockstep — they did diverge once,
 * the previous 8-char prefix was flagged in review for collision risk.
 */
const CREDENTIAL_SHORT_LEN = 12;

function credentialShortId(credentialId: string | undefined): string {
  if (!credentialId) return '';
  return credentialId.replace(/-/g, '').slice(0, CREDENTIAL_SHORT_LEN);
}

/**
 * Compute the per-credential Bifrost custom-provider name for
 * `openai_compatible`. Mirrors the `as-tei-<service>` pattern that
 * built-in TEI deployments use, but scoped to the credential UUID so
 * two credentials in the same project that point at different upstream
 * endpoints get different Bifrost providers (and therefore different
 * `network_config.base_url`s, which is the whole point).
 *
 * Format: `as-openai-compat-<credShortId>`. The `openai-compat`
 * segment matches the AgentStudio credential schema field
 * (`credentials.provider = 'openai_compatible'`) so a reader can trace
 * a provider name straight back to the row that produced it. It also
 * distinguishes from the `as-tei-*` family (in-cluster TEI deployments)
 * and from Bifrost's native `openai` / `azure` / `bedrock` / `gemini`
 * providers. `credShortId` is the first `CREDENTIAL_SHORT_LEN` chars of
 * the credential UUID (no dashes) — same convention as
 * `buildGatewayBindingName`.
 *
 * Returns `undefined` when there's no credential to scope to — caller
 * should fall back to a different provider strategy (typically the
 * static `mapLlmProviderToBifrost` table).
 */
export function buildOpenAICompatibleProviderName(
  credentialId: string | undefined,
): string | undefined {
  const short = credentialShortId(credentialId);
  if (!short) return undefined;
  return `as-openai-compat-${short}`;
}

/**
 * Resolve the Bifrost provider name for an AgentStudio LLM provider.
 *
 * `openai_compatible` needs a credentialId to compute its per-credential
 * custom-provider name (`as-openai-compat-<short>`). When the caller can't supply
 * one (e.g. legacy direct gateway-route callers, list endpoints that
 * don't know which credential they're inspecting), `openai_compatible`
 * falls back to `'openai'` — matching the pre-fix behavior so listing
 * existing rows still works.
 *
 * Every other provider is resolved by the static table.
 */
export function mapLlmProviderToBifrost(
  provider?: string,
  credentialId?: string,
): string {
  if (!provider) return 'openai';
  if (provider === 'openai_compatible') {
    const custom = buildOpenAICompatibleProviderName(credentialId);
    // Fallback: legacy callers that don't pass credentialId get the
    // pre-fix `'openai'` mapping. Calls that actually need to talk to
    // the upstream (addModel, deleteModel, the model.gatewayModelId
    // computation in modelRoutes) MUST pass credentialId so the right
    // custom provider name flows through.
    return custom || 'openai';
  }
  return LLM_PROVIDER_TO_BIFROST[provider] || provider;
}

/**
 * Build the ready-to-send Bifrost model id from a model record.
 *
 * Bifrost rejects bare deployment names with `provider is required` because
 * routing rules are scoped per-provider. Rather than have every caller
 * (agent-service Python runtime, playground infer fallback, etc.) repeat
 * the prefix logic, we compute it once at registration time and store it
 * on the Model entity as `gatewayModelId`. Callers send it verbatim.
 *
 * For `openai_compatible`, the provider prefix is the per-credential
 * custom Bifrost provider name (`as-openai-compat-<short>`) — not Bifrost's native
 * `openai` provider, which would route to `api.openai.com`. Callers that
 * use `openai_compatible` MUST pass `credentialId`; if they don't, this
 * falls through to `'openai'` to preserve legacy lookups, which means
 * runtime calls would mis-route to OpenAI's hardcoded base URL — so
 * always pass `credentialId` for `openai_compatible` at registration
 * time.
 *
 * Pre-prefixed values (already containing `/`) are returned unchanged so
 * operator-managed routes can opt out.
 */
export function buildGatewayModelId(
  llmProvider: string | undefined,
  modelIdent: string,
  credentialId?: string,
): string {
  if (!modelIdent) return modelIdent;
  if (modelIdent.includes('/')) return modelIdent;
  return `${mapLlmProviderToBifrost(llmProvider, credentialId)}/${modelIdent}`;
}

/**
 * Build the unique Bifrost-side identifier for a (project, credential, model).
 *
 * The team-scoped routing rules Bifrost creates already segregate two
 * projects that register the same upstream model. What they don't
 * segregate is two credentials in the SAME project registering the same
 * upstream model: the CEL `request.model == "<providerModelId>"` would
 * be identical for both. We work around that by routing on this
 * composite identifier instead of the bare provider model id.
 *
 * Format:
 *   - With credential:    `<projectId>_<credentialShortId>_<providerModelId>`
 *   - Without credential: `<projectId>_<providerModelId>` (e.g. local provider)
 *   - Without project:    falls back to `providerModelId` (callers using
 *                          the gateway routes directly without a project)
 *
 * `credentialShortId` is the first `CREDENTIAL_SHORT_LEN` chars of the
 * credential UUID — 12 hex chars (~280T possible values) gives ample
 * disambiguation within a single project's credential set.
 */

/** Bifrost provider names for in-cluster TEI built-ins (`as-tei-<key>`). */
export function isPlatformTeiProvider(providerName: string): boolean {
  return providerName.startsWith('as-tei-');
}

/**
 * Platform-wide binding id for a built-in TEI model. Shared by every
 * project's virtual key — NOT scoped with `projectId` (each model already
 * has its own `as-tei-*` provider, unlike shared cloud providers).
 */
export function buildBuiltinGatewayBindingName(providerModelId: string): string {
  return providerModelId.replace(/\//g, '__');
}

function legacyProjectScopedBuiltinBindingPattern(canonical: string): RegExp {
  const escaped = canonical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^proj[a-z0-9]+_${escaped}$`);
}

/** True when `stored` is a deprecated per-project alias of `canonical`. */
export function isLegacyProjectScopedBuiltinBinding(
  stored: string,
  canonical: string,
): boolean {
  return stored !== canonical && legacyProjectScopedBuiltinBindingPattern(canonical).test(stored);
}

/** Collapse provider-key `models[]` to one canonical built-in binding. */
export function mergeBuiltinProviderKeyModels(prior: string[], canonical: string): string[] {
  const kept = prior.filter(
    (m) => m !== canonical && !isLegacyProjectScopedBuiltinBinding(m, canonical),
  );
  return [...new Set([...kept, canonical])];
}

/** Collapse VK `allowed_models` for a built-in TEI provider entry. */
export function mergeBuiltinVirtualKeyAllowedModels(
  allowed: string[],
  canonical: string,
): string[] {
  const kept = allowed.filter(
    (m) => m !== canonical && !isLegacyProjectScopedBuiltinBinding(m, canonical),
  );
  return [...new Set([...kept, canonical])];
}

export function buildGatewayBindingName(
  projectId: string | undefined,
  credentialId: string | undefined,
  providerModelId: string,
  llmProvider?: string,
): string {
  if (!providerModelId) return providerModelId;
  // For `openai_compatible`, the Bifrost-side provider is per-credential
  // (`as-openai-compat-<short>`), so the binding name lives inside a single
  // credential's namespace and doesn't need the project__cred__ scoping.
  // Critically, Bifrost forwards the binding name verbatim to the upstream
  // proxy after stripping the `as-openai-compat-<short>/` prefix — the upstream
  // expects e.g. `claude-opus-4.7`, not `projyvm9qey7_dee9b9f3_claude-opus-4.7`,
  // so we MUST return the bare providerModelId for this provider type.
  // For native Bifrost providers (openai, azure, bedrock, gemini), the
  // provider is shared across all credentials, so the project__cred__
  // scoping remains necessary to avoid binding-name collisions.
  if (llmProvider === 'openai_compatible') {
    return providerModelId;
  }
  if (!projectId) return providerModelId;
  const credShort = credentialShortId(credentialId);
  return credShort
    ? `${projectId}_${credShort}_${providerModelId}`
    : `${projectId}_${providerModelId}`;
}

/**
 * Bifrost v1.5 wraps secret-bearing fields (key value, Azure endpoint /
 * api_version, bedrock / vertex credentials) in an env-aware object rather
 * than a bare string. `from_env: false` means the literal `value` is used.
 */
export interface BifrostEnvValue {
  value: string;
  env_var: string;
  from_env: boolean;
}

export interface BifrostKeyPayload {
  name: string;
  value?: BifrostEnvValue;
  models: string[];
  weight?: number;
  enabled?: boolean;
  /**
   * Maps the routing identifier (gateway binding name) to the upstream
   * provider id (Azure deployment name, bare model id, ...). Replaces the
   * pre-v1.5 `azure_key_config.deployments` map.
   */
  aliases?: Record<string, string>;
  azure_key_config?: Record<string, unknown>;
  bedrock_key_config?: Record<string, unknown>;
  vertex_key_config?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AppendProviderKeyInput {
  llmProvider: string;
  modelId: string;
  providerModelId: string;
  /**
   * Upstream provider deployment/inference name when it differs from `providerModelId`.
   * When the gateway provider exposes a deployment routing map, this value is
   * the upstream id Bifrost forwards to. When omitted, falls back to identity
   * (`providerModelId == deployment`).
   */
  providerDeploymentName?: string;
  /**
   * Unique Bifrost-side routing identifier for this (project, credential,
   * model). When provided, this is the key in `models[]`, the key in the
   * provider deployment-routing map (when applicable), and the value the
   * routing CEL matches against (`request.model == "<gatewayBindingName>"`).
   * When omitted, falls back to `providerModelId` (legacy bare-name flow).
   */
  gatewayBindingName?: string;
  /** When set, all models using this credential share one Bifrost provider key. */
  credentialId?: string;
  /** Shown on the Bifrost key (description) so keys are findable in the Bifrost UI. */
  credentialName?: string;
  projectId?: string;
  apiKey?: string;
  apiBase?: string;
  /**
   * Service-account JSON string for Bifrost's `vertex` provider
   * (`vertex_key_config.auth_credentials`). Sourced from the credential's
   * secret data (not metadata) by the addModel route, so it never lands in
   * the persisted Model row. Empty/absent falls back to ADC/IAM auth.
   */
  authCredentials?: string;
  credentialMetadata?: Record<string, unknown>;
  /**
   * Optional proxy concurrency override for the gateway provider config.
   * When omitted we preserve the provider's existing value.
   */
  concurrency?: number;
  /**
   * Optional proxy buffer-size override for the gateway provider config.
   * When omitted we preserve the provider's existing value.
   */
  bufferSize?: number;
}

export interface AppendProviderKeyResult {
  gatewayProvider: string;
  keyName: string;
  keyId?: string;
}

function authHeaders(): Record<string, string> {
  const key = resolveGatewayApiKey();
  if (!key) return {};
  return { Authorization: `Bearer ${key}`, 'x-api-key': key };
}

function createClient(): AxiosInstance {
  return axios.create({
    baseURL: resolveGatewayBaseUrl(),
    timeout: Number(process.env.LLM_GATEWAY_TIMEOUT_MS ?? '15000'),
    headers: authHeaders(),
  });
}

/** Per-model key (legacy) or one key per project credential (wizard flow). */
export function resolveProviderKeyName(modelId: string, credentialId?: string): string {
  if (credentialId) return `as-cred-${credentialId}`;
  return `as-${modelId}`;
}

/** @deprecated Use resolveProviderKeyName */
export function providerKeyName(modelId: string): string {
  return resolveProviderKeyName(modelId);
}

/**
 * Gateway providers that need an `azure_key_config` block on the Bifrost key
 * (endpoint, api_version, optional AAD auth). Today only Azure. Note that the
 * binding→deployment routing now lives in the key's top-level `aliases` map.
 */
function bifrostProviderUsesDeploymentMap(llmProvider: string): boolean {
  return llmProvider === 'azure';
}

/**
 * Wrap a plain string into Bifrost v1.5's env-aware value object. Returns
 * undefined for empty/absent input so callers can omit the field entirely.
 */
function envValue(value?: string): BifrostEnvValue | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return { value, env_var: '', from_env: false };
}

/**
 * Inverse of `envValue` for the read path: when Bifrost returns a key whose
 * `value` is the env-aware object form (`{ value, env_var, from_env }`),
 * flatten it back to a plain string so callers downstream can compare
 * `key.value === apiKey` and treat the whole row as a flat record.
 *
 * Keys whose `value` is already a string (or missing) are passed through
 * unchanged. Required by every read site that calls `getProviderState` and
 * then iterates `current.keys` — without it, the post-`envValue` round-trip
 * leaves `key.value` as `{ value: '<the-key>', ... }`, which breaks the
 * idempotency check that short-circuits no-op PUTs.
 */
export function normalizeBifrostKeyValue(
  key: Record<string, unknown>,
): Record<string, unknown> {
  const val = key.value;
  // `val &&` already excludes null/undefined (typeof null === 'object',
  // but null is falsy); the extra `val !== null` check that lived here
  // earlier was redundant and tripped CodeQL's inconvertible-types rule.
  if (val && typeof val === 'object' && 'value' in (val as object)) {
    return { ...key, value: (val as { value: string }).value };
  }
  return key;
}

/**
 * Build the key's `aliases` map: routing identifier (gateway binding name) →
 * upstream provider id (Azure deployment, bare model id, ...). In Bifrost
 * v1.5 this replaces the old `azure_key_config.deployments` map and applies to
 * every provider that uses the project-scoped binding scheme. `prior` carries
 * forward aliases already on the key when extending it.
 */
function buildAliasMap(
  bindingName: string,
  upstreamId: string,
  prior?: Record<string, string>,
): Record<string, string> {
  if (!isSafeDeploymentKey(bindingName)) {
    throw new Error(`Invalid gateway binding name: ${bindingName}`);
  }
  const aliases = new Map<string, string>();
  if (prior) {
    for (const [k, v] of Object.entries(prior)) {
      if (!isSafeDeploymentKey(k)) continue;
      aliases.set(k, v);
    }
  }
  aliases.set(bindingName, upstreamId);
  return Object.fromEntries(aliases);
}

function buildAzureKeyConfig(
  input: AppendProviderKeyInput,
  meta: Record<string, unknown>,
): Record<string, unknown> {
  const azureCfg: Record<string, unknown> = {
    endpoint: envValue(
      (input.apiBase as string) ||
        (meta.endpoint as string) ||
        (meta.api_base as string),
    ),
    api_version: envValue(
      (meta.api_version as string) ||
        (meta.apiVersion as string) ||
        AZURE_OPENAI_DEFAULT_API_VERSION,
    ),
  };
  // Azure AD (client-credentials) auth, when supplied via credential metadata.
  if (meta.client_id && meta.client_secret && meta.tenant_id) {
    azureCfg.client_id = envValue(meta.client_id as string);
    azureCfg.client_secret = envValue(meta.client_secret as string);
    azureCfg.tenant_id = envValue(meta.tenant_id as string);
    azureCfg.scopes = ['https://cognitiveservices.azure.com/.default'];
  }
  return azureCfg;
}

export function buildKeyPayload(input: AppendProviderKeyInput): BifrostKeyPayload {
  const keyName = resolveProviderKeyName(input.modelId, input.credentialId);
  // The routing-side identifier Bifrost matches `request.model` against.
  // Defaults to the bare upstream provider id for legacy callers that have
  // not adopted the binding-name scheme yet.
  const bindingName = input.gatewayBindingName || input.providerModelId;
  // Upstream id Bifrost forwards to: Azure deployment name when distinct,
  // otherwise the bare provider model id.
  const upstreamId = input.providerDeploymentName || input.providerModelId;

  const base: BifrostKeyPayload = {
    name: keyName,
    value: envValue(input.apiKey),
    models: [bindingName],
    weight: 1,
    enabled: true,
  };

  // When the routing id differs from the upstream id (always true for the
  // project-scoped `<project>_<cred>_<model>` binding scheme), Bifrost needs
  // an alias so it can resolve `request.model` to the upstream deployment /
  // model. Pre-v1.5 this lived in `azure_key_config.deployments`.
  if (bindingName !== upstreamId) {
    base.aliases = buildAliasMap(bindingName, upstreamId);
  }

  if (input.credentialName) {
    const projectHint = input.projectId ? ` project=${input.projectId}` : '';
    base.description = `AgentStudio credential: ${input.credentialName}${projectHint}`;
  }

  const meta = input.credentialMetadata || {};
  if (bifrostProviderUsesDeploymentMap(input.llmProvider)) {
    base.azure_key_config = buildAzureKeyConfig(input, meta);
  }

  if (input.llmProvider === 'aws_bedrock') {
    const bedrockCfg: Record<string, unknown> = {
      region: envValue(
        (meta.region as string) || (meta.aws_region as string) || 'us-east-1',
      ),
    };
    const accessKey = (meta.access_key as string) || input.apiKey;
    if (accessKey) bedrockCfg.access_key = envValue(accessKey);
    if (meta.secret_key) bedrockCfg.secret_key = envValue(meta.secret_key as string);
    if (meta.session_token) {
      bedrockCfg.session_token = envValue(meta.session_token as string);
    }
    base.bedrock_key_config = bedrockCfg;
    // Bedrock auth lives entirely in bedrock_key_config; drop the unused
    // top-level value so the "value must not be empty" check doesn't fire.
    if (input.apiKey && !meta.secret_key) {
      delete base.value;
    }
  }

  if (input.llmProvider === 'google') {
    // Google Vertex AI. Bifrost's `vertex` provider authenticates via a
    // service-account JSON scoped to a project + region — NOT a top-level
    // key value (which is why we drop `base.value` below, mirroring bedrock).
    // Required: project_id + region. Optional: project_number (fine-tuned
    // models only) and auth_credentials (empty => ADC / IAM role auth).
    const vertexCfg: Record<string, unknown> = {
      project_id: envValue(
        (meta.project_id as string) || (meta.projectId as string),
      ),
      region: envValue(
        (meta.region as string) || (meta.location as string) || 'us-central1',
      ),
    };
    const projectNumber =
      (meta.project_number as string) || (meta.projectNumber as string);
    if (projectNumber) {
      vertexCfg.project_number = envValue(projectNumber);
    }
    const authCredentials =
      input.authCredentials ||
      (meta.auth_credentials as string) ||
      (meta.service_account_json as string);
    if (authCredentials) {
      vertexCfg.auth_credentials = envValue(authCredentials);
    }
    base.vertex_key_config = vertexCfg;
    // Vertex auth lives entirely in vertex_key_config; drop the unused
    // top-level value so Bifrost's "value must not be empty" check doesn't fire.
    delete base.value;
  }

  return base;
}

export interface GatewayModelEntry {
  provider: string;
  keyId?: string;
  keyName?: string;
  modelId: string;
  enabled?: boolean;
  status?: string;
  description?: string;
  weight?: number;
}

/** Flatten Bifrost provider keys into model entries (no secrets). */
export async function listGatewayModels(
  client?: AxiosInstance,
): Promise<{ models: GatewayModelEntry[]; total: number; providers: string[] }> {
  const c = client || createClient();
  const { providers } = await listGatewayProviders(c);
  const models: GatewayModelEntry[] = [];
  const providerNames: string[] = [];

  for (const p of providers) {
    const providerName = String((p as { name?: string }).name || '');
    if (!providerName) continue;
    providerNames.push(providerName);
    // Bifrost v1.5 no longer embeds `keys` on the provider object; fetch them
    // from the dedicated keys subresource. Best-effort per provider so one
    // failing provider doesn't blank the whole listing.
    let keys: Record<string, unknown>[] = [];
    try {
      keys = await listProviderKeys(providerName, c);
    } catch {
      keys = [];
    }
    for (const key of keys) {
      const keyId = key.id as string | undefined;
      const keyName = key.name as string | undefined;
      const enabled = key.enabled as boolean | undefined;
      const status = key.status as string | undefined;
      const description = key.description as string | undefined;
      const weight = key.weight as number | undefined;
      const modelIds = (key.models as string[]) || [];
      for (const modelId of modelIds) {
        if (!modelId) continue;
        models.push({
          provider: providerName,
          keyId,
          keyName,
          modelId,
          enabled,
          status,
          description,
          weight,
        });
      }
    }
  }

  return { models, total: models.length, providers: providerNames };
}

/**
 * List a provider's API keys via the dedicated v1.5 subresource
 * (`GET /api/providers/{provider}/keys`). Key values are redacted in the
 * response. Pre-v1.5 these lived embedded on the provider object.
 */
export async function listProviderKeys(
  bifrostProvider: string,
  client?: AxiosInstance,
): Promise<Record<string, unknown>[]> {
  const c = client || createClient();
  const resp = await c.get(
    `/api/providers/${encodeURIComponent(bifrostProvider)}/keys`,
  );
  const body = (resp.data as { keys?: Record<string, unknown>[] }) || {};
  return body.keys || [];
}

export async function listGatewayProviders(
  client?: AxiosInstance,
): Promise<{ providers: Record<string, unknown>[]; total?: number }> {
  const c = client || createClient();
  const resp = await c.get('/api/providers');
  const body = resp.data || {};
  return {
    providers: body.providers || [],
    total: body.total,
  };
}

export async function getProviderState(
  bifrostProvider: string,
  client?: AxiosInstance,
): Promise<Record<string, unknown> | null> {
  const { providers } = await listGatewayProviders(client);
  return (
    providers.find((p) => (p as { name?: string }).name === bifrostProvider) as
      | Record<string, unknown>
      | undefined
  ) || null;
}

export async function ensureProviderConfigured(
  bifrostProvider: string,
  client?: AxiosInstance,
): Promise<Record<string, unknown>> {
  const c = client || createClient();
  let current = await getProviderState(bifrostProvider, c);
  if (current) return current;

  console.log(
    `[bifrostProviderOps] Provider '${safeLog(bifrostProvider)}' not configured in Bifrost; auto-creating`,
  );
  try {
    await c.post('/api/providers', { provider: bifrostProvider });
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status !== 409) throw err;
  }
  current = await getProviderState(bifrostProvider, c);
  if (!current) {
    throw new Error(
      `Failed to auto-create Bifrost provider '${bifrostProvider}'`,
    );
  }
  return current;
}

export async function appendProviderKey(
  input: AppendProviderKeyInput,
  client?: AxiosInstance,
): Promise<AppendProviderKeyResult> {
  const c = client || createClient();
  const gatewayProvider = mapLlmProviderToBifrost(input.llmProvider);
  await ensureProviderConfigured(gatewayProvider, c);

  // Bifrost v1.5 manages provider keys through a dedicated subresource; the
  // embedded `keys[]` on the provider object (and the ability to mutate it via
  // `PUT /api/providers/{name}`) was removed. We read existing keys from
  // `GET /api/providers/{provider}/keys`, then create (`POST`) a new key or
  // extend an existing per-credential key (`PUT /keys/{id}`).
  const existingKeys = await listProviderKeys(gatewayProvider, c);
  const newKey = buildKeyPayload(input);
  const keyName = newKey.name;

  const duplicate = existingKeys.find((k) => (k.name as string) === keyName);
  let keyId: string | undefined;

  if (duplicate && duplicate.id) {
    keyId = duplicate.id as string;
    const priorModels = (duplicate.models as string[]) || [];
    const newModelId = (newKey.models as string[])[0];
    const mergedModels = [...new Set([...priorModels, newModelId])];
    const mergedAliases = {
      ...((duplicate.aliases as Record<string, string>) || {}),
      ...((newKey.aliases as Record<string, string>) || {}),
    };
    // PUT is a full replace (no partial PATCH), and key values are write-only
    // (redacted on read). Re-send the freshly-built key — which carries the
    // real value from the same credential — extended with the merged models +
    // aliases. Omitting `value` here would wipe the stored secret.
    const putBody: Record<string, unknown> = {
      ...newKey,
      id: keyId,
      models: mergedModels,
    };
    if (Object.keys(mergedAliases).length) {
      putBody.aliases = mergedAliases;
    }
    await c.put(
      `/api/providers/${encodeURIComponent(gatewayProvider)}/keys/${encodeURIComponent(keyId)}`,
      putBody,
    );
  } else {
    const resp = await c.post(
      `/api/providers/${encodeURIComponent(gatewayProvider)}/keys`,
      newKey,
    );
    keyId = (resp.data as { id?: string } | undefined)?.id;
  }

  // Provider-level proxy tuning is independent of keys; apply it (key-free)
  // only when an explicit override is supplied. Best-effort: a tuning write
  // must not fail an otherwise-successful key registration.
  if (
    typeof input.concurrency === 'number' &&
    input.concurrency > 0 &&
    typeof input.bufferSize === 'number' &&
    input.bufferSize > 0
  ) {
    try {
      await updateProviderProxyOnGateway(
        gatewayProvider,
        input.concurrency,
        input.bufferSize,
        c,
      );
    } catch (err) {
      safeConsoleWarn(
        '[bifrostProviderOps] provider proxy-config update failed for',
        gatewayProvider,
        (err as Error).message,
      );
    }
  }

  return { gatewayProvider, keyName, keyId };
}

/**
 * Apply provider-level proxy tuning (concurrency + buffer size) on the Bifrost
 * gateway. This is a key-free `PUT /api/providers/{provider}` carrying only the
 * `concurrency_and_buffer_size` block, which Bifrost merges into the existing
 * provider config. Callers own error handling: the model-registration path
 * treats a failure as best-effort (see `appendProviderKey`), while the provider
 * proxy-edit route logs but still persists the operator's intent to the cache.
 */
export async function updateProviderProxyOnGateway(
  bifrostProvider: string,
  concurrency: number,
  bufferSize: number,
  client?: AxiosInstance,
): Promise<void> {
  const c = client || createClient();
  await c.put(`/api/providers/${encodeURIComponent(bifrostProvider)}`, {
    concurrency_and_buffer_size: {
      concurrency,
      buffer_size: bufferSize,
    },
  });
}

/** Remove one deployment/model id from a shared credential key; drop key if no models left. */
export async function removeProviderModelFromKey(
  bifrostProvider: string,
  keyName: string,
  providerModelId: string,
  client?: AxiosInstance,
  currentApiKey?: string,
): Promise<boolean> {
  const c = client || createClient();
  const keys = await listProviderKeys(bifrostProvider, c);
  const target = keys.find((k) => (k.name as string) === keyName);
  if (!target || !target.id) return false;
  const keyId = target.id as string;

  const remaining = ((target.models as string[]) || []).filter(
    (m) => m !== providerModelId,
  );
  if (remaining.length === 0) {
    // No models left on the key — delete the whole key (no value needed).
    await c.delete(
      `/api/providers/${encodeURIComponent(bifrostProvider)}/keys/${encodeURIComponent(keyId)}`,
    );
    return true;
  }

  // Trimming one model from a multi-model key requires a full-replace PUT,
  // which would blank the write-only key value unless we re-send it. Without
  // the real secret we leave the stale models[] entry in place — harmless,
  // since the VK allowed_models + the deleted model row already remove it
  // from routing.
  if (!currentApiKey) {
    safeConsoleWarn(
      '[bifrostProviderOps] left model on key (no current api key available to preserve the key value during trim)',
      providerModelId,
      keyName,
    );
    return false;
  }

  const aliases = { ...((target.aliases as Record<string, string>) || {}) };
  delete aliases[providerModelId];
  const putBody: Record<string, unknown> = {
    id: keyId,
    name: target.name,
    value: { value: currentApiKey, env_var: '', from_env: false },
    models: remaining,
    weight: (target.weight as number | undefined) ?? 1,
    enabled: (target.enabled as boolean | undefined) ?? true,
  };
  if (Object.keys(aliases).length) putBody.aliases = aliases;
  if (target.azure_key_config) putBody.azure_key_config = target.azure_key_config;
  if (target.bedrock_key_config) putBody.bedrock_key_config = target.bedrock_key_config;
  if (target.vertex_key_config) putBody.vertex_key_config = target.vertex_key_config;
  if (target.description) putBody.description = target.description;

  await c.put(
    `/api/providers/${encodeURIComponent(bifrostProvider)}/keys/${encodeURIComponent(keyId)}`,
    putBody,
  );
  return true;
}

export async function removeProviderKeyByName(
  bifrostProvider: string,
  keyName: string,
  client?: AxiosInstance,
): Promise<boolean> {
  const c = client || createClient();
  const keys = await listProviderKeys(bifrostProvider, c);
  const target = keys.find((k) => (k.name as string) === keyName);
  if (!target || !target.id) return false;

  await c.delete(
    `/api/providers/${encodeURIComponent(bifrostProvider)}/keys/${encodeURIComponent(target.id as string)}`,
  );
  return true;
}

export async function deleteProviderKeyById(
  bifrostProvider: string,
  keyId: string,
  client?: AxiosInstance,
): Promise<void> {
  const c = client || createClient();
  await c.delete(
    `/api/providers/${encodeURIComponent(bifrostProvider)}/keys/${encodeURIComponent(keyId)}`,
  );
}

// ---------------------------------------------------------------------------
// Built-in (custom-provider) registration path — used by BuiltinModelsService
// for in-cluster TEI embedding models. Distinct from the credentialed
// `appendProviderKey` path because:
//   - The Bifrost provider name is supplied directly (e.g. `as-tei-minilm`)
//     and does NOT go through `mapLlmProviderToBifrost`.
//   - The provider carries a `network_config.base_url` pointing at the
//     in-cluster TEI Service (not a public LLM provider endpoint).
//   - The provider is configured as openai-compatible (`base_provider_type:
//     'openai'`) so Bifrost wraps the upstream as an OpenAI-shaped client.
//   - One key per provider; the model id is added to the key's `models[]`.
//   - No credential is required (TEI has no auth in-cluster).
// ---------------------------------------------------------------------------

export interface AppendBuiltinProviderKeyInput {
  /** Full Bifrost provider name to use, verbatim (e.g. `as-tei-minilm`, `as-openai-compat-<short>`). */
  providerName: string;
  /** Model id put on the key's `models[]` — what Bifrost matches to route. */
  modelId: string;
  /** Upstream HTTP base URL for the OpenAI-compatible API (e.g. `http://tei-minilm.<ns>.svc.cluster.local:80/v1`). */
  apiBase: string;
  /** Placeholder api_key. TEI doesn't need auth; Bifrost requires a non-empty value. */
  apiKey: string;
  /** Optional human-readable description on the key. */
  description?: string;
  /**
   * Optional override for the custom provider's `allowed_requests`.
   * Defaults to `{embedding: true}` for built-in TEI parity. Remote
   * `openai_compatible` callers that need chat completions too should
   * pass `{embedding: true, chat: true}` (or whatever the upstream
   * supports — Bifrost refuses request types that aren't allowed).
   */
  allowedRequests?: Record<string, boolean>;
  /**
   * Optional name for the key. Defaults to `<providerName>-key` so reruns
   * find/update the same key. `openai_compatible` doesn't need to
   * override this — the provider name is already per-credential, so the
   * default key name is unique enough.
   */
  keyName?: string;
  /**
   * Opt the provider into Bifrost's `network_config.allow_private_network`.
   * Bifrost v1.5.9+ blocks connections to RFC1918 private IPs by default
   * (SSRF protection) — which breaks in-cluster providers whose `base_url`
   * resolves to a ClusterIP (e.g. the built-in TEI Service). Set true ONLY
   * for trusted in-cluster upstreams (built-in TEI); leave false for
   * user-registered `openai_compatible` providers so their URLs can't be
   * pointed at internal services. Link-local (169.254.x) stays blocked
   * regardless. Default false.
   */
  allowPrivateNetwork?: boolean;
}

export interface AppendBuiltinProviderKeyResult {
  providerName: string;
  keyName: string;
  keyId?: string;
}

/**
 * Idempotent create-or-update of a custom Bifrost provider that fronts an
 * in-cluster openai-compatible service. The provider's `network_config.base_url`
 * and `custom_provider_config` come from the input; the key carries `modelId`
 * in its `models[]`. Repeated calls dedup the model on the existing key.
 *
 * Tolerant of duplicate-shape errors at any layer (provider POST 409, PUT
 * race with another caller) so this can run on every project init and on
 * every config-service startup without producing noisy log lines.
 */
export async function appendBuiltinProviderKey(
  input: AppendBuiltinProviderKeyInput,
  client?: AxiosInstance,
): Promise<AppendBuiltinProviderKeyResult> {
  const c = client || createClient();
  const providerName = input.providerName;
  // One key per provider — name is stable so reruns find and update the
  // same key rather than creating new ones. No slashes (the upstream
  // model id may contain them, but the key name should not). Callers
  // may override (e.g. to share a credential across model rows) but the
  // default is sufficient because the provider name is already
  // sufficiently scoped (per-TEI-service or per-credential).
  const keyName = input.keyName || `${providerName}-key`;
  // Normalize the user-provided apiBase: strip trailing slashes + a single
  // trailing `/v1`. Done with a programmatic char-walk rather than a regex
  // (`/\/+$/`) because the regex form was flagged as a polynomial regex on
  // uncontrolled data by CodeQL — an attacker-supplied apiBase with a long
  // tail of '/' characters could degrade matching to O(n²) on some
  // engines. The walk is unconditionally O(n) and produces the same
  // result.
  const baseUrl = stripV1AndTrailingSlashes(input.apiBase);
  const allowedRequests = input.allowedRequests || { embedding: true };
  const allowPrivateNetwork = input.allowPrivateNetwork || false;

  // Step 1: ensure the provider exists (with network_config so Bifrost
  // knows where to route). POST may 409 if a concurrent caller created
  // it first; treat as success.
  let current = await getProviderState(providerName, c);
  if (!current) {
    try {
      await c.post('/api/providers', {
        provider: providerName,
        network_config: { base_url: baseUrl, allow_private_network: allowPrivateNetwork },
        custom_provider_config: {
          base_provider_type: 'openai',
          allowed_requests: allowedRequests,
        },
      });
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status !== 409) throw err;
    }
    current = await getProviderState(providerName, c);
    if (!current) {
      throw new Error(`Failed to auto-create Bifrost provider '${providerName}'`);
    }
  }

  // Step 2: (re-)assert provider-level config (base_url / allowed_requests /
  // concurrency) only when it drifted. This is the provider-level PUT, which
  // Bifrost v1.5 still honors for provider fields. Keys are NOT sent here —
  // see Step 3.
  const concurrency = current.concurrency_and_buffer_size as
    | { concurrency?: number; buffer_size?: number }
    | undefined;
  const existingNetwork = current.network_config as
    | { base_url?: string; allow_private_network?: boolean }
    | undefined;
  // Re-PUT on base_url drift, OR when this provider must allow private-network
  // access (built-in TEI) but the live config hasn't been flipped yet — the
  // latter heals existing providers created before the SSRF guard landed.
  if (
    existingNetwork?.base_url !== baseUrl ||
    (allowPrivateNetwork && existingNetwork?.allow_private_network !== true)
  ) {
    try {
      await c.put(`/api/providers/${encodeURIComponent(providerName)}`, {
        network_config: { base_url: baseUrl, allow_private_network: allowPrivateNetwork },
        custom_provider_config: {
          base_provider_type: 'openai',
          allowed_requests: allowedRequests,
        },
        // Match the credentialed path's defaults so TEI traffic isn't
        // throttled 10x harder than cloud providers.
        concurrency_and_buffer_size:
          concurrency?.concurrency && concurrency.concurrency > 0
            ? concurrency
            : { concurrency: 1000, buffer_size: 5000 },
      });
    } catch (err) {
      safeConsoleWarn(
        '[bifrostProviderOps] provider config update failed for',
        providerName,
        (err as Error).message,
      );
    }
  }

  // Step 3: create/update the key via the dedicated v1.5 keys subresource.
  // CRITICAL: the embedded `keys[]` on `PUT /api/providers/{name}` was removed
  // in Bifrost v1.5 and is silently ignored — writing keys there left built-in
  // TEI providers key-less (`GET .../keys` -> `{keys:null}`), so `keyId` came
  // back undefined and the caller's VK binding + `gatewayModelId` stamping
  // never ran (every embedding then 500'd with "provider openai not found").
  // Mirror the credentialed `appendProviderKey` path: POST to create, PUT to
  // extend the existing per-provider key.
  const existingKeys = await listProviderKeys(providerName, c);
  const existing = existingKeys.find((k) => (k.name as string) === keyName);

  let keyId: string | undefined;
  if (existing && existing.id) {
    keyId = existing.id as string;
    const priorModels = (existing.models as string[]) || [];
    const mergedModels = isPlatformTeiProvider(providerName)
      ? mergeBuiltinProviderKeyModels(priorModels, input.modelId)
      : priorModels.includes(input.modelId)
        ? priorModels
        : [...new Set([...priorModels, input.modelId])];
    const modelsChanged =
      mergedModels.length !== priorModels.length ||
      mergedModels.some((m) => !priorModels.includes(m)) ||
      priorModels.some((m) => !mergedModels.includes(m));
    if (modelsChanged) {
      // PUT is a full replace and key values are write-only (redacted on
      // read), so re-send the placeholder value to avoid wiping it.
      await c.put(
        `/api/providers/${encodeURIComponent(providerName)}/keys/${encodeURIComponent(keyId)}`,
        {
          name: keyName,
          value: envValue(input.apiKey),
          models: mergedModels,
          weight: (existing.weight as number | undefined) ?? 1,
          enabled: (existing.enabled as boolean | undefined) ?? true,
          ...(input.description ? { description: input.description } : {}),
        },
      );
    }
  } else {
    const resp = await c.post(
      `/api/providers/${encodeURIComponent(providerName)}/keys`,
      {
        name: keyName,
        value: envValue(input.apiKey),
        models: [input.modelId],
        weight: 1,
        enabled: true,
        ...(input.description ? { description: input.description } : {}),
      },
    );
    keyId = (resp.data as { id?: string } | undefined)?.id;
    if (!keyId) {
      // Some Bifrost builds return 201 with an empty body; re-read to resolve.
      const after = await listProviderKeys(providerName, c);
      keyId = after.find((k) => (k.name as string) === keyName)?.id as
        | string
        | undefined;
    }
  }

  return { providerName, keyName, keyId };
}
