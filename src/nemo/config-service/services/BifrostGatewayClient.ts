import axios, { AxiosInstance } from 'axios';
import { get_logger } from '@agentstudio/observability-client-runtime';

const logger = get_logger();
import {
  AddModelRequest,
  ChatCompletionRequest,
  ChatCompletionResult,
  EditMCPServerRequest,
  GatewayMCPServerResponse,
  GatewayModelRegistration,
  ILLMGatewayClient,
  MCPToolInfo,
  NewMCPServerRequest,
  NormalizedUsage,
  TestConnectionResult,
} from './LLMGatewayClient';
import {
  appendBuiltinProviderKey,
  appendProviderKey,
  buildBuiltinGatewayBindingName,
  buildOpenAICompatibleProviderName,
  getProviderState,
  isPlatformTeiProvider,
  listProviderKeys,
  removeProviderKeyByName,
  removeProviderModelFromKey,
  resolveProviderKeyName,
} from './bifrost/bifrostProviderOps';
import { buildGatewayBindingName } from './bifrost/bifrostProviderOps';
import {
  appendMcpClientToProjectVirtualKey,
  assignModelGovernance,
  assignModelToProjectVirtualKey,
  ensureProjectGateway,
  removeMcpClientFromProjectVirtualKey,
  removeModelGovernance,
  unassignModelFromProjectVirtualKey,
  type ModelGovernanceLimits,
} from './bifrost/bifrostProjectGovernance';
import { resolveGatewayApiKey, resolveGatewayBaseUrl } from './gatewayClient';
import { safeLog } from '../utils/safeStrings';

const GATEWAY_URL = resolveGatewayBaseUrl();
const GATEWAY_API_KEY = resolveGatewayApiKey();
const GATEWAY_TIMEOUT_MS = Number(process.env.LLM_GATEWAY_TIMEOUT_MS ?? '30000');
const MCP_TIMEOUT_MS = Number(process.env.LLM_GATEWAY_MCP_TIMEOUT_MS ?? '120000');
const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

export { mapLlmProviderToBifrost } from './bifrost/bifrostProviderOps';
import { mapLlmProviderToBifrost } from './bifrost/bifrostProviderOps';
import {
  bifrostPrefixedToolName,
  extractClientIdFromAddResponse,
  fetchBifrostMcpClients,
  parseBifrostMcpListEntry,
  parseToolsFromListEntry,
  reconnectBifrostMcpClient,
} from './bifrost/bifrostMcpOps';

/** Coerce a value to a finite number, or null when absent/invalid. */
function numericOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Narrow an arbitrary value to a supported spending period, else null. */
function normalizeSpendingPeriod(
  value: unknown,
): 'day' | 'week' | 'month' | null {
  return value === 'day' || value === 'week' || value === 'month' ? value : null;
}

export class BifrostGatewayClient implements ILLMGatewayClient {
  private client: AxiosInstance;
  private enabled: boolean;

  constructor() {
    this.enabled = !!GATEWAY_URL;
    const headers: Record<string, string> = {};
    if (GATEWAY_API_KEY) {
      headers.Authorization = `Bearer ${GATEWAY_API_KEY}`;
      headers['x-api-key'] = GATEWAY_API_KEY;
    }
    this.client = axios.create({
      baseURL: GATEWAY_URL,
      timeout: GATEWAY_TIMEOUT_MS,
      headers,
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private authHeaders(): Record<string, string> {
    if (!GATEWAY_API_KEY) return {};
    return {
      Authorization: `Bearer ${GATEWAY_API_KEY}`,
      'x-api-key': GATEWAY_API_KEY,
    };
  }

  /**
   * Register a system-managed built-in embedding model (in-cluster TEI) as a
   * custom Bifrost provider + assign it to the project's virtual key.
   *
   * The caller (BuiltinModelsService.registerBuiltinsWithGatewayForProject)
   * populates `model_info` with:
   *   - `isBuiltin: true` (selects this code path)
   *   - `provider: 'as-tei-<svc>'` (Bifrost provider name to create/update)
   *   - `providerModelId` (HF model id, e.g. `sentence-transformers/...`)
   *   - `projectId` (used to look up the VK)
   *   - `gatewayBindingName` (what Bifrost matches on the wire)
   * and `provider_params.api_base` (TEI service URL).
   *
   * Idempotent: re-running with the same args dedups against existing
   * provider state and VK assignments.
   */
  private async addBuiltinModel(
    request: AddModelRequest,
  ): Promise<GatewayModelRegistration | void> {
    const projectId = request.model_info?.projectId as string | undefined;
    const providerName = request.model_info?.provider as string | undefined;
    const providerModelId =
      (request.model_info?.providerModelId as string | undefined) ||
      request.provider_params.model?.replace(/^openai\//, '') ||
      request.model_name;
    const apiBase = request.provider_params.api_base;
    const apiKey = request.provider_params.api_key || 'tei-no-auth';
    // HuggingFace model ids contain a slash (`<org>/<model>`). Slashes are
    // structural separators on the wire form `<bifrost-provider>/<binding>`
    // and conflict with the same module's `SAFE_DEPLOYMENT_KEY` regex, so
    // sanitize before composing the binding name. `__` collides with no
    // existing convention and round-trips uniquely.
    const gatewayBindingName =
      (request.model_info?.gatewayBindingName as string | undefined) ||
      buildBuiltinGatewayBindingName(providerModelId);

    if (!providerName) {
      throw new Error(
        `addBuiltinModel: model_info.provider is required (the Bifrost provider name, e.g. "as-tei-minilm")`,
      );
    }
    if (!apiBase) {
      throw new Error(
        `addBuiltinModel: provider_params.api_base is required (the upstream TEI service URL)`,
      );
    }
    if (!projectId) {
      throw new Error(
        `addBuiltinModel: model_info.projectId is required so the model can be assigned to the project's virtual key`,
      );
    }

    const projectGateway = await ensureProjectGateway(projectId, this.client);
    if (!projectGateway) {
      // Fail loudly rather than silently skip VK assignment — without
      // `assignModelToProjectVirtualKey` the project's VK wouldn't list
      // this binding in `allowed_models`, and every runtime call for this
      // built-in would 401/403 with "model not in allowed_models".
      throw new Error(
        `addBuiltinModel: ensureProjectGateway returned null for project ${projectId}; refusing to register a built-in whose VK assignment would silently no-op`,
      );
    }

    const { keyName, keyId } = await appendBuiltinProviderKey(
      {
        providerName,
        modelId: gatewayBindingName,
        apiBase,
        apiKey,
        description: `AgentStudio built-in: ${request.model_name}`,
        // Built-in TEI lives in-cluster; its base_url resolves to a ClusterIP
        // (RFC1918). Bifrost v1.5.9+ blocks private IPs unless the provider
        // opts in. Safe here because the URL is operator-controlled (the TEI
        // Service), NOT user input — unlike the openai_compatible path below.
        allowPrivateNetwork: true,
      },
      this.client,
    );
    logger.info(
      `[BifrostGatewayClient] addBuiltinModel provider=${safeLog(providerName)} key=${safeLog(keyName)} model=${safeLog(gatewayBindingName)}`,
    );

    if (!keyId) {
      throw new Error(
        `Bifrost provider key id missing for built-in '${keyName}' while binding model '${gatewayBindingName}' to project VK`,
      );
    }
    // When the caller batches many built-ins (BuiltinModelsService), it
    // defers the VK assignment so every binding lands in ONE atomic
    // provider_configs write instead of N concurrent read-modify-write PUTs
    // that clobber each other (the lost-update race that left project VKs
    // with only a subset of the catalog). The caller then invokes
    // `assignBuiltinModelsToProjectVirtualKey` once with every binding
    // returned here. Non-batched callers keep the per-model assign.
    const deferVirtualKeyAssignment =
      request.model_info?.deferVirtualKeyAssignment === true;
    if (!deferVirtualKeyAssignment) {
      await assignModelToProjectVirtualKey(
        projectId,
        {
          provider: providerName,
          modelId: gatewayBindingName,
          providerKeyId: keyId,
        },
        this.client,
      );
    }

    return {
      gatewayProvider: providerName,
      keyName,
      keyId,
      providerModelId,
      gatewayBindingName,
      bifrostTeamId: projectGateway.teamId,
      bifrostVirtualKeyId: projectGateway.virtualKeyId,
    };
  }

  async addModel(request: AddModelRequest): Promise<GatewayModelRegistration | void> {
    if (!this.enabled) return;

    // Built-in TEI embedding models take a different path: each TEI service
    // is its own Bifrost custom provider (with a `network_config.base_url`
    // pointing at the in-cluster Service) rather than a key against a known
    // upstream like `openai` / `azure`. See `appendBuiltinProviderKey` for
    // the shape; the call below is the only place that path is invoked.
    if (request.model_info?.isBuiltin === true) {
      return this.addBuiltinModel(request);
    }

    const modelId = request.model_name;
    const llmProvider = (request.model_info?.provider as string | undefined) || 'openai';
    const providerModelId =
      request.model_info?.providerModelId ||
      request.provider_params.model?.replace(/^openai\//, '') ||
      modelId;

    const credentialId = request.model_info?.credentialId as string | undefined;
    const credentialName = request.model_info?.credentialName as string | undefined;
    const projectId = request.model_info?.projectId as string | undefined;
    const providerDeploymentName = request.model_info?.providerDeploymentName as
      | string
      | undefined;
    // Unique routing identifier for this (project, credential, model). Falls
    // back to `providerModelId` when the caller didn't supply one (legacy
    // direct gateway-route callers) so the existing bare-name flow keeps
    // working. New registrations from modelRoutes always pass this.
    const gatewayBindingName =
      (request.model_info?.gatewayBindingName as string | undefined)
      || providerModelId;
    const projectGateway = projectId ? await ensureProjectGateway(projectId, this.client) : null;

    // `openai_compatible` with an explicit endpoint takes the custom-
    // provider path (mirror of the TEI built-in path) so Bifrost
    // routes to the user's upstream URL, not api.openai.com. Without
    // this branch, any model registered as openai_compatible against a
    // corporate proxy / on-prem endpoint silently routes to OpenAI and
    // 403s from the egress filter (verified on sks6316). Falls through
    // to the legacy `appendProviderKey` path when:
    //   - The provider is a native Bifrost provider (openai, azure,
    //     aws_bedrock, google, ollama).
    //   - openai_compatible is used WITHOUT an apiBase (legacy direct-
    //     gateway-route flows where the URL came from somewhere else).
    let gatewayProvider: string;
    let keyName: string;
    let keyId: string | undefined;
    const apiBase = request.provider_params.api_base;
    if (llmProvider === 'openai_compatible' && apiBase && credentialId) {
      const providerName = buildOpenAICompatibleProviderName(credentialId)!;
      const description = credentialName
        ? `AgentStudio openai_compatible credential: ${credentialName}${projectId ? ` project=${projectId}` : ''}`
        : undefined;
      const result = await appendBuiltinProviderKey(
        {
          providerName,
          modelId: gatewayBindingName,
          apiBase,
          // Bifrost requires a non-empty key value even for endpoints that
          // don't need auth. For openai_compatible the credential supplies a
          // real bearer; fall back to a placeholder if absent (e.g. for
          // anonymous proxies) so the registration doesn't fail validation.
          apiKey: request.provider_params.api_key || 'openai-compat-no-auth',
          description,
          // Remote openai_compatible upstreams typically serve both chat
          // and embedding endpoints; some clients also use the newer
          // OpenAI `/v1/responses` shape. Built-in TEI only serves
          // embeddings (its own default); we explicitly opt in here so
          // chat models (claude, gpt-*, etc. via internal proxies) work.
          //
          // Field names MUST match Bifrost's actual schema — descriptive
          // snake_case like `chat_completion`, NOT the abbreviated
          // `chat`. Unknown keys are silently ignored by Bifrost, which
          // surfaces as "chat_completion is not supported by <provider>"
          // at runtime. See the live shape:
          //   wget -qO- http://bifrost-proxy:8080/api/providers/as-openai-compat-<id>
          //     | jq .custom_provider_config.allowed_requests
          allowedRequests: {
            chat_completion: true,
            chat_completion_stream: true,
            embedding: true,
            responses: true,
            responses_stream: true,
            // `list_models` lets clients call /v1/models for discovery;
            // harmless to enable for upstreams that support it, and
            // upstreams that don't will just return 404.
            list_models: true,
          },
        },
        this.client,
      );
      gatewayProvider = result.providerName;
      keyName = result.keyName;
      keyId = result.keyId;
    } else {
      const result = await appendProviderKey(
        {
          llmProvider,
          modelId,
          providerModelId,
          providerDeploymentName,
          gatewayBindingName,
          credentialId,
          credentialName,
          projectId,
          apiKey: request.provider_params.api_key,
          apiBase: request.provider_params.api_base,
          // Service-account JSON for Vertex (`vertex_key_config.auth_credentials`).
          // Carried on provider_params (not model_info) so it stays out of the
          // persisted Model row; see modelRoutes credential-secret handling.
          authCredentials: request.provider_params.auth_credentials as string | undefined,
          credentialMetadata: request.model_info?.credentialMetadata as Record<string, unknown> | undefined,
          concurrency: numericOrNull(request.model_info?.concurrentRequests) ?? undefined,
          bufferSize: numericOrNull(request.model_info?.bufferSize) ?? undefined,
        },
        this.client,
      );
      gatewayProvider = result.gatewayProvider;
      keyName = result.keyName;
      keyId = result.keyId;
    }
    // bifrostProvider == gatewayProvider by definition: both name the
    // Bifrost provider where the key now lives. Computing it from the
    // branch result (not from `mapLlmProviderToBifrost(llmProvider,
    // credentialId)` again) guarantees the VK assignment below targets
    // the same provider we just wrote to, even in edge cases like
    // `openai_compatible` without apiBase where the branch falls through
    // to `appendProviderKey` and resolves to Bifrost's native `openai`.
    const bifrostProvider = gatewayProvider;
    logger.info(
      `[BifrostGatewayClient] addModel provider key ${safeLog(keyName)}` +
        (credentialName ? ` (credential: ${safeLog(credentialName)})` : '') +
        ` models=[${safeLog(gatewayBindingName)}]` +
        (gatewayBindingName !== providerModelId
          ? ` (upstream=${safeLog(providerModelId)})`
          : '') +
        (providerDeploymentName && providerDeploymentName !== providerModelId
          ? ` -> deployment=${safeLog(providerDeploymentName)}`
          : ''),
    );

    let resolvedProviderKeyId = keyId;
    if (!resolvedProviderKeyId && projectId) {
      // Bifrost can coalesce/reshape provider keys; recover key id by either
      // exact key name or the newly bound model identifier. v1.5 exposes keys
      // via the dedicated subresource (no longer embedded on the provider).
      const keys = await listProviderKeys(gatewayProvider, this.client);
      const matchedByName = keys.find((k) => (k.name as string | undefined) === keyName);
      const matchedByModel = keys.find((k) => {
        const models = (k.models as string[]) || [];
        return models.includes(gatewayBindingName);
      });
      const candidate = matchedByName || matchedByModel;
      resolvedProviderKeyId = candidate?.id as string | undefined;
    }

    // Per-model Bifrost routing rule creation used to live here. It was
    // removed -- agent-service and the playground send the provider-
    // prefixed `gatewayModelId` (e.g. `azure/<binding>`) directly on
    // every chat-completion, and Bifrost natively dispatches that form
    // without needing a per-model CEL rule. The `targets[]` arrays the
    // rule used to carry are now redundant; provider + binding + key
    // already live on the VK's `provider_configs` (assigned below).
    // See `bifrostOps.ts` for the removal rationale.

    if (projectId && projectGateway) {
      if (!resolvedProviderKeyId) {
        throw new Error(
          `Bifrost provider key id missing for '${keyName}' while binding model '${gatewayBindingName}' to project VK`,
        );
      }

      await assignModelToProjectVirtualKey(
        projectId,
        {
          provider: bifrostProvider,
          // VK allowed_models[] must list the same identifier callers
          // send as `request.model` on the wire (i.e. the provider-
          // prefixed `gatewayModelId` resolves to this `gatewayBindingName`
          // upstream); otherwise Bifrost denies the request after auth.
          modelId: gatewayBindingName,
          providerKeyId: resolvedProviderKeyId,
        },
        this.client,
      );

      // Per-model budget + rate limit. Maps the model's rpm / tpm /
      // spendingLimit onto a Bifrost `model-config` scoped to the project
      // VK, keyed on the same `gatewayBindingName` used in allowed_models.
      // Best-effort: a governance write failure must not roll back a model
      // that already routes successfully.
      const governanceLimits: ModelGovernanceLimits = {
        rpm: numericOrNull(request.model_info?.rpm),
        tpm: numericOrNull(request.model_info?.tpm),
        spendingLimit: numericOrNull(request.model_info?.spendingLimit),
        spendingLimitPeriod: normalizeSpendingPeriod(
          request.model_info?.spendingLimitPeriod,
        ),
      };
      try {
        await assignModelGovernance(
          projectId,
          { provider: bifrostProvider, modelName: gatewayBindingName },
          governanceLimits,
          this.client,
        );
      } catch (err: any) {
        const msg = err.response?.data?.error?.message || err.message;
        logger.warn(
          `[BifrostGatewayClient] addModel: model governance write failed for ${safeLog(gatewayBindingName)}: ${safeLog(msg)}`,
        );
      }
    }

    return {
      gatewayProvider,
      keyName,
      keyId: resolvedProviderKeyId,
      credentialId,
      providerModelId,
      providerDeploymentName,
      gatewayBindingName,
      bifrostTeamId: projectGateway?.teamId,
      bifrostVirtualKeyId: projectGateway?.virtualKeyId,
    };
  }

  async deleteModel(
    modelId: string,
    options?: {
      gatewayProvider?: string;
      keyName?: string;
      providerModelId?: string;
      /**
       * Unique Bifrost routing identifier from the new project__cred__model
       * scheme. When the model row has this populated we must use it for the
       * VK unassign + provider-key models[] removal, otherwise we'd try to
       * remove a name Bifrost doesn't recognise and leak the entry.
       */
      gatewayBindingName?: string;
      credentialId?: string;
      /**
       * Decrypted provider secret for the model's credential. Required to trim
       * one model off a shared, multi-model provider key: Bifrost's keys PUT is
       * full-replace and blanks the write-only value unless we re-send it.
       */
      currentApiKey?: string;
      projectId?: string;
      provider?: string;
    },
  ): Promise<void> {
    if (!this.enabled) return;

    // What Bifrost has stored in routing CEL / VK allowed_models / provider
    // key models[]: prefer the binding name when present, else fall back to
    // the legacy bare providerModelId for older registrations.
    const bifrostModelIdent =
      options?.gatewayBindingName || options?.providerModelId;

    if (options?.projectId) {
      try {
        // Resolve via credentialId so `openai_compatible` lands on the right
        // per-credential `as-openai-compat-<short>` provider, not Bifrost's native
        // `openai`. The model row's stored gatewayProvider wins when set
        // (callers pass it from the model record); falling back to
        // mapLlmProviderToBifrost is the legacy path for rows registered
        // before gatewayProvider was persisted.
        const bifrostProvider = options.gatewayProvider
          || (options.provider
                ? mapLlmProviderToBifrost(options.provider, options.credentialId)
                : undefined);
        const bindingId = bifrostModelIdent || modelId;
        if (bifrostProvider) {
          await unassignModelFromProjectVirtualKey(
            options.projectId,
            { provider: bifrostProvider, modelId: bindingId },
            this.client,
          );
          // Tear down the per-model budget/rate-limit model-config too, so a
          // deleted model doesn't leave orphaned governance state on the VK.
          await removeModelGovernance(
            options.projectId,
            { provider: bifrostProvider, modelName: bindingId },
            this.client,
          );
        }
      } catch (err: any) {
        const msg = err.response?.data?.error?.message || err.message;
        logger.warn(
          `[BifrostGatewayClient] deleteModel: VK provider_configs cleanup failed for ${safeLog(modelId)}: ${safeLog(msg)}`,
        );
      }
    }

    // Routing-rule cleanup used to live here; removed alongside
    // routing-rule creation in addModel. See `bifrostOps.ts`.

    const bifrostProvider = options?.gatewayProvider;
    const keyName =
      options?.keyName || resolveProviderKeyName(modelId, options?.credentialId);
    // Built-in TEI providers (`as-tei-*`) are platform-shared: seeded once and
    // re-asserted idempotently at config-service startup + project init, one
    // `as-tei-*` provider per model with a single shared key holding that one
    // model. They are NOT owned by any project. Removing the model here would
    // empty the shared key, and `removeProviderModelFromKey` deletes a key once
    // its last model is gone — so tearing down one project would delete the
    // shared built-in key and break embeddings for every OTHER live project
    // ("no keys found for provider: as-tei-*"). The VK-level unassign above is
    // project-scoped and safe; the shared provider key must be left intact.
    if (bifrostProvider && isPlatformTeiProvider(bifrostProvider)) {
      logger.info(
        `[BifrostGatewayClient] deleteModel: preserving shared built-in provider key ${safeLog(keyName)} for ${safeLog(bifrostProvider)} (platform-managed)`,
      );
    } else if (bifrostProvider && keyName) {
      try {
        if (bifrostModelIdent) {
          await removeProviderModelFromKey(
            bifrostProvider,
            keyName,
            bifrostModelIdent,
            this.client,
            options?.currentApiKey,
          );
          logger.info(
            `[BifrostGatewayClient] deleteModel removed ${safeLog(bifrostModelIdent)} from key ${safeLog(keyName)}`,
          );
        } else {
          await removeProviderKeyByName(bifrostProvider, keyName, this.client);
          logger.info(`[BifrostGatewayClient] deleteModel removed provider key ${safeLog(keyName)}`);
        }
      } catch (err: any) {
        const msg = err.response?.data?.error?.message || err.message;
        logger.warn(`[BifrostGatewayClient] deleteModel provider key warning for ${safeLog(modelId)}: ${safeLog(msg)}`);
      }
    }
  }

  async chatCompletion(
    request: ChatCompletionRequest,
    options?: { apiKey?: string },
  ): Promise<ChatCompletionResult> {
    if (!this.enabled) {
      throw new Error('Bifrost gateway is not configured');
    }

    try {
      // Bifrost exposes its OpenAI-compatible chat-completions API under
      // /litellm/v1 (this is Bifrost's own endpoint name, kept for protocol
      // compat; it is not a LiteLLM dependency).
      //
      // Per-call bearer: when the caller supplies `options.apiKey` we
      // override the singleton's cluster-master headers for this
      // request only. Used by per-project entry points (the playground
      // `/:id/infer` route) so requests carry the project VK and
      // Bifrost team-scoped routing + budgets / rate-limits apply
      // instead of being bypassed by the shared master credential.
      const perCallHeaders = options?.apiKey
        ? {
            Authorization: `Bearer ${options.apiKey}`,
            'x-api-key': options.apiKey,
          }
        : this.authHeaders();
      const resp = await this.client.post(
        '/litellm/v1/chat/completions',
        request,
        { timeout: 120_000, headers: perCallHeaders },
      );
      const data = resp.data || {};
      const messageContent = data?.choices?.[0]?.message?.content;
      const responseText = typeof messageContent === 'string' ? messageContent : '';
      const modelName = data?.model || request.model;
      const usageRaw = data?.usage || {};
      const usage: NormalizedUsage | undefined =
        usageRaw.prompt_tokens != null ||
        usageRaw.completion_tokens != null ||
        usageRaw.total_tokens != null
          ? {
              promptTokens: usageRaw.prompt_tokens,
              completionTokens: usageRaw.completion_tokens,
              totalTokens: usageRaw.total_tokens,
            }
          : undefined;

      return { response: responseText, modelName, usage };
    } catch (err: any) {
      const status = err.response?.status;
      const detail =
        err.response?.data?.error?.message ||
        err.response?.data?.detail ||
        err.message ||
        'Bifrost chat completion failed';
      const e = new Error(`Bifrost chatCompletion failed: ${detail}`) as Error & { status?: number };
      e.status = status;
      throw e;
    }
  }

  private mapTransport(transport?: string): 'http' | 'sse' | 'stdio' {
    if (transport === 'sse') return 'sse';
    if (transport === 'stdio') return 'stdio';
    return 'http';
  }

  private coerceHeaderMap(
    raw?: Record<string, unknown> | Record<string, string> | null,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [k, v] of Object.entries(raw)) {
      if (v === undefined || v === null) continue;
      const key = String(k).trim();
      if (!key) continue;
      out[key] = String(v);
    }
    return out;
  }

  /** UI staticHeaders + headerParams + auth → Bifrost `headers` on POST /api/mcp/client. */
  private remoteMcpHeaders(request: NewMCPServerRequest | EditMCPServerRequest): Record<string, string> {
    const headers = this.coerceHeaderMap(request.static_headers);
    const creds = request.credentials;
    if (!creds) return headers;

    const authValue = creds.auth_value || creds.api_key || creds.token;
    if (authValue) {
      if (request.auth_type === 'bearer_token') {
        if (!headers.Authorization) headers.Authorization = `Bearer ${authValue}`;
      } else if (request.auth_type === 'api_key') {
        if (!headers.Authorization && !headers['x-api-key']) {
          headers['x-api-key'] = authValue;
        }
      } else if (!headers.Authorization) {
        headers.Authorization = authValue;
      }
    }
    if (creds.client_id && !headers['x-client-id']) headers['x-client-id'] = creds.client_id;
    if (creds.client_secret && !headers['x-client-secret']) {
      headers['x-client-secret'] = creds.client_secret;
    }
    return headers;
  }

  /** Bifrost tool allowlists. Tools remain callable via `tools_to_execute`;
   * auto-execute is always disabled so MCP tools require explicit invocation. */
  private mcpToolAllowlists(allowedTools?: string[]): {
    tools_to_execute: string[];
    tools_to_auto_execute: string[];
  } {
    const list = allowedTools?.length ? allowedTools : ['*'];
    return { tools_to_execute: list, tools_to_auto_execute: [] };
  }

  /**
   * Force-disable Bifrost auto-execute for an MCP client. Bifrost's POST
   * /api/mcp/client sometimes defaults `tools_to_auto_execute` to `["*"]`
   * even when the create body sends `[]`; a follow-up PUT reliably clears it.
   */
  private async disableMcpClientAutoExecute(clientId: string): Promise<void> {
    if (!clientId) return;
    try {
      await this.client.put(
        `/api/mcp/client/${encodeURIComponent(clientId)}`,
        { tools_to_auto_execute: [] },
      );
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || err.message;
      logger.warn(
        `[BifrostGatewayClient] disableMcpClientAutoExecute failed for ${safeLog(clientId)}: ${safeLog(msg)}`,
      );
    }
  }

  /**
   * Remote MCP registration body for POST /api/mcp/client (Bifrost).
   * Example SSE:
   *   { name, connection_type: "sse", connection_string, headers: {}, tools_to_execute: ["*"], ... }
   */
  private buildMcpClientBody(request: NewMCPServerRequest): Record<string, unknown> {
    const connectionType = this.mapTransport(request.transport);
    const body: Record<string, unknown> = {
      name: request.server_name,
      connection_type: connectionType,
      allow_on_all_virtual_keys: false,
      ...this.mcpToolAllowlists(request.allowed_tools),
    };
    if (request.blocked_tools?.length) {
      body.tools_to_exclude = request.blocked_tools;
    }
    if (request.description) body.description = request.description;

    if (connectionType === 'stdio') {
      body.stdio_config = {
        command: request.command,
        args: request.args || [],
        envs: request.env ? Object.keys(request.env) : [],
      };
      if (request.env) {
        body.env = request.env;
      }
    } else {
      body.connection_string = request.url;
      const headers = this.remoteMcpHeaders(request);
      body.headers = headers;
      if (Object.keys(headers).length > 0) {
        body.auth_type = 'headers';
      }
    }
    // Forward-header allowlist: Bifrost (v1.5+) field is `allowed_extra_headers`
    // — a list of request header *names* it will pass through to the MCP
    // server at tool-execution time (distinct from the static `headers` map).
    if (request.extra_headers?.length) {
      body.allowed_extra_headers = request.extra_headers;
    }
    return body;
  }

  private async getMcpClientEntry(serverName: string): Promise<{
    summary: { server_id: string; server_name: string };
    raw: Record<string, unknown>;
  } | null> {
    const rows = await fetchBifrostMcpClients(this.client);
    for (const row of rows) {
      const summary = parseBifrostMcpListEntry(row);
      if (summary && summary.server_name === serverName) {
        return { summary, raw: row };
      }
    }
    return null;
  }

  async addMCPServer(request: NewMCPServerRequest): Promise<GatewayMCPServerResponse> {
    if (!this.enabled) throw new Error('Bifrost gateway is not configured');

    const body = this.buildMcpClientBody(request);
    logger.info(
      `[BifrostGatewayClient] addMCPServer: POST /api/mcp/client name=${safeLog(request.server_name)} ` +
        `transport=${safeLog(body.connection_type)} url=${safeLog(body.connection_string ?? '(stdio)')}`,
    );
    if (DEBUG) {
      // Log only known-safe, non-secret summary fields. The full MCP
      // client body contains `headers` / `env` / `stdio_config` which
      // hold bearer tokens, x-api-key, authorization headers, and
      // resolved credentials. Earlier revisions deep-cloned the body
      // and ran a redacting replacer; CodeQL js/clear-text-logging
      // could not statically trace that the replacer always ran, so
      // the value-flow from `request.credentials.api_key` /
      // `headers['x-api-key']` into the log still triggered the rule.
      // Building an explicit DTO with only the structural fields
      // removes those flow edges entirely.
      const headersKeys =
        body.headers && typeof body.headers === 'object'
          ? Object.keys(body.headers as Record<string, unknown>)
          : [];
      const envKeys =
        body.env && typeof body.env === 'object'
          ? Object.keys(body.env as Record<string, unknown>)
          : [];
      const summary = {
        name: body.name,
        connection_type: body.connection_type,
        connection_string: body.connection_string,
        auth_type: body.auth_type,
        allow_on_all_virtual_keys: body.allow_on_all_virtual_keys,
        tools_to_execute: body.tools_to_execute,
        tools_to_auto_execute: body.tools_to_auto_execute,
        tools_to_exclude: body.tools_to_exclude,
        allowed_extra_headers: body.allowed_extra_headers,
        // Surface NAMES of headers/env vars (already safe identifiers
        // checked by isSafeHeaderName upstream) but never their values.
        headers_keys: headersKeys,
        env_keys: envKeys,
        has_stdio_config: !!body.stdio_config,
      };
      logger.info(
        `[BifrostGatewayClient] addMCPServer body=${JSON.stringify(summary)}`,
      );
    }
    try {
      const resp = await this.client.post('/api/mcp/client', body);
      const data = (resp.data?.client || resp.data || {}) as Record<string, unknown>;
      let clientId =
        extractClientIdFromAddResponse(data) ||
        extractClientIdFromAddResponse({ client: data }) ||
        String((data as any).mcp_client_id ?? '');
      const mcpName = String((data.config as Record<string, unknown> | undefined)?.name ?? data.name ?? request.server_name);
      if (!clientId) {
        // Bifrost's POST /api/mcp/client response doesn't always include the
        // generated client_id. The reconnect endpoint requires the UUID
        // (HTTP 500 if a name is passed), so look it up via GET.
        const entry = await this.getMcpClientEntry(mcpName);
        clientId = entry?.summary.server_id ?? '';
      }

      if (clientId && clientId !== mcpName) {
        await reconnectBifrostMcpClient(this.client, clientId);
      }
      // Bifrost may default auto-execute to `["*"]` on create; enforce off.
      if (clientId) {
        await this.disableMcpClientAutoExecute(clientId);
      }
      // Map this MCP client onto the project's Bifrost virtual key
      // `mcp_configs` (mirrors `addModel` -> `allowed_models`). Bifrost
      // registers the client with `allow_on_all_virtual_keys: false`, so a
      // client that is NOT in the VK's `mcp_configs` is unreachable by the
      // project VK (both the aggregated `/mcp` proxy AND chat-completion MCP
      // injection filter on it). This write is what makes the tool reachable
      // at all.
      //
      // Project-wide reachability is intentional and safe: per-AGENT scoping
      // is enforced downstream by agent-service-maf, which (a) only exposes
      // an agent's own configured servers client-side (`build_toolset`) and
      // (b) sends a per-request `x-bf-mcp-include-tools` header — including a
      // deny-all scope for agents with no MCP servers — so Bifrost never
      // expands the full VK `mcp_configs` for an unconfigured agent.
      //
      // Best-effort: a governance write failure must not roll back an MCP
      // client that already registered successfully.
      if (request.projectId) {
        try {
          await appendMcpClientToProjectVirtualKey(
            request.projectId,
            mcpName,
            request.allowed_tools,
            this.client,
          );
        } catch (govErr: any) {
          const msg = govErr.response?.data?.error?.message || govErr.message;
          logger.warn(
            `[BifrostGatewayClient] addMCPServer: VK mcp_configs write failed for ${safeLog(mcpName)}: ${safeLog(msg)}`,
          );
        }
      }
      const cfg = (data.config as Record<string, unknown> | undefined) || data;
      return {
        server_id: clientId || mcpName,
        server_name: mcpName,
        alias: request.alias,
        url: request.url,
        transport: request.transport,
        auth_type: request.auth_type,
      };
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || err.response?.data?.detail || err.message;
      throw new Error(`Bifrost addMCPServer failed: ${msg}`);
    }
  }

  async editMCPServer(request: EditMCPServerRequest): Promise<void> {
    if (!this.enabled) throw new Error('Bifrost gateway is not configured');

    const body: Record<string, unknown> = {};
    if (request.server_name) body.name = request.server_name;
    if (request.transport) body.connection_type = this.mapTransport(request.transport);
    if (request.url) body.connection_string = request.url;
    if (request.allowed_tools) {
      Object.assign(body, this.mcpToolAllowlists(request.allowed_tools));
    }
    if (request.blocked_tools) body.tools_to_exclude = request.blocked_tools;
    if (
      request.url !== undefined ||
      request.static_headers !== undefined ||
      request.credentials !== undefined ||
      request.auth_type !== undefined
    ) {
      const headers = this.remoteMcpHeaders(request);
      body.headers = headers;
      if (Object.keys(headers).length > 0) {
        body.auth_type = 'headers';
      }
    }
    // Re-sync the forward-header allowlist on edit. An explicit (possibly
    // empty) array clears it; `undefined` leaves it untouched.
    if (request.extra_headers !== undefined) {
      body.allowed_extra_headers = request.extra_headers;
    }
    // Always disable auto-execute on edit so legacy clients registered with
    // `tools_to_auto_execute: ["*"]` are corrected on the next sync.
    if (Object.keys(body).length > 0) {
      body.tools_to_auto_execute = [];
    }

    try {
      await this.client.put(
        `/api/mcp/client/${encodeURIComponent(request.server_id)}`,
        body,
      );
      await reconnectBifrostMcpClient(this.client, request.server_id);
      await this.disableMcpClientAutoExecute(request.server_id);
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || err.response?.data?.detail || err.message;
      throw new Error(`Bifrost editMCPServer failed: ${msg}`);
    }
  }

  async removeMCPServer(
    serverId: string,
    options?: { projectId?: string; mcpClientName?: string },
  ): Promise<void> {
    if (!this.enabled) return;

    // Inverse of the add path: unbind this MCP client from the project VK's
    // `mcp_configs` so a deleted tool can no longer be reached through the
    // VK (mirrors `unassignModelFromProjectVirtualKey` on model delete).
    // Best-effort and idempotent — skipped when the caller can't identify
    // the owning project / client name. Project deletion still drops the VK
    // wholesale via `teardownProjectGateway`.
    if (options?.projectId && options?.mcpClientName) {
      try {
        await removeMcpClientFromProjectVirtualKey(
          options.projectId,
          options.mcpClientName,
          this.client,
        );
      } catch (govErr: any) {
        const msg = govErr.response?.data?.error?.message || govErr.message;
        logger.warn(
          `[BifrostGatewayClient] removeMCPServer: VK mcp_configs unbind failed for ${safeLog(options.mcpClientName)}: ${safeLog(msg)}`,
        );
      }
    }

    try {
      await this.client.delete(
        `/api/mcp/client/${encodeURIComponent(serverId)}`,
      );
    } catch (err: any) {
      if (err.response?.status === 404) {
        logger.warn(`[BifrostGatewayClient] MCP client ${safeLog(serverId)} not found, skipping`);
        return;
      }
      const msg = err.response?.data?.error?.message || err.message;
      logger.error(`[BifrostGatewayClient] removeMCPServer failed for ${safeLog(serverId)}: ${safeLog(msg)}`);
    }
  }

  async listMCPServers(): Promise<GatewayMCPServerResponse[]> {
    if (!this.enabled) return [];

    const rows = await fetchBifrostMcpClients(this.client);
    return rows
      .map((row) => parseBifrostMcpListEntry(row))
      .filter((s): s is NonNullable<typeof s> => !!s)
      .map((s) => ({
        server_id: s.server_id,
        server_name: s.server_name,
        url: s.url,
        transport: s.transport,
        auth_type: s.auth_type,
      }));
  }

  async testMCPConnection(serverName: string): Promise<TestConnectionResult> {
    if (!this.enabled) throw new Error('Bifrost gateway is not configured');

    try {
      const entry = await this.getMcpClientEntry(serverName);
      if (!entry) {
        return { success: false, message: `Bifrost MCP client not found: ${serverName}` };
      }
      await reconnectBifrostMcpClient(this.client, entry.summary.server_id);
      const tools = await this.listMCPTools(serverName);
      const state = entry.raw.state as string | undefined;
      const stateHint = state ? ` (state=${state})` : '';
      return {
        success: true,
        message: `Connected${stateHint} — ${tools.length} tool(s) available`,
      };
    } catch (err: any) {
      return { success: false, message: err.message || 'Connection failed' };
    }
  }

  async listMCPTools(serverName: string): Promise<MCPToolInfo[]> {
    if (!this.enabled) return [];

    const entry = await this.getMcpClientEntry(serverName);
    if (!entry) {
      throw new Error(`Bifrost MCP client not found: ${serverName}`);
    }
    return parseToolsFromListEntry(entry.raw);
  }

  async callMCPTool(
    serverName: string,
    toolName: string,
    args: Record<string, any>,
    options?: {
      timeoutMs?: number;
      forwardHeaders?: Record<string, string>;
    },
  ): Promise<any> {
    if (!this.enabled) throw new Error('Bifrost gateway is not configured');

    const entry = await this.getMcpClientEntry(serverName);
    if (!entry) {
      throw new Error(`Bifrost MCP client not found: ${serverName}`);
    }

    const callId = `as-${Date.now()}`;
    const headers = {
      ...this.authHeaders(),
      ...(options?.forwardHeaders || {}),
    };
    const argString = typeof args === 'string' ? args : JSON.stringify(args ?? {});
    const payload = {
      id: callId,
      type: 'function',
      function: {
        name: '',
        arguments: argString,
      },
    };
    const execute = async (name: string): Promise<any> => {
      payload.function.name = name;
      const call = async (path: string): Promise<any> => {
        const resp = await this.client.post(
          path,
          payload,
          { timeout: options?.timeoutMs ?? MCP_TIMEOUT_MS, headers },
        );
        const data = resp.data;
        if (data?.content != null) return data.content;
        return data?.result ?? data;
      };
      try {
        return await call('/v1/mcp/tool/execute');
      } catch (err: any) {
        const status = err.response?.status;
        const msg = String(
          err.response?.data?.error?.message
          || err.response?.data?.detail
          || err.message
          || '',
        );
        const retryOnApiPath =
          status === 404
          || status === 405
          || msg.includes('not available or not permitted');
        if (retryOnApiPath) {
          return call('/api/mcp/tool/execute');
        }
        throw err;
      }
    };

    const prefixed = bifrostPrefixedToolName(serverName, toolName);
    try {
      return await execute(prefixed);
    } catch (err: any) {
      const msg = String(
        err.response?.data?.error?.message
        || err.response?.data?.detail
        || err.message
        || '',
      );
      const retryableNameError =
        msg.includes('not available or not permitted')
        || msg.includes('Tool not found')
        || msg.includes('tool not found');
      if (retryableNameError && prefixed !== toolName) {
        try {
          return await execute(toolName);
        } catch (retryErr: any) {
          const retryMsg =
            retryErr.response?.data?.error?.message
            || retryErr.response?.data?.detail
            || retryErr.message;
          throw new Error(`MCP tool call failed: ${retryMsg}`);
        }
      }
      throw new Error(`MCP tool call failed: ${msg}`);
    }
  }

  /** JSON-RPC via aggregated /mcp (agent-service streamable HTTP). */
  buildAgentMcpUrl(): string {
    return `${GATEWAY_URL}/mcp`;
  }

  buildAgentMcpHeaders(): Record<string, string> {
    return this.authHeaders();
  }
}
