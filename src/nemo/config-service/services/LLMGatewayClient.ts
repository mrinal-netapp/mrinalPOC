/**
 * Shared LLM gateway client interface (Bifrost).
 */

export interface BifrostModelParams {
  model: string;
  api_key?: string;
  api_base?: string;
  [key: string]: any;
}

export interface AddModelRequest {
  model_name: string;
  provider_params: BifrostModelParams;
  model_info?: Record<string, any>;
}

export interface NewMCPServerRequest {
  server_name: string;
  /** AgentStudio project — ensures Bifrost team/VK and attaches MCP to project VK. */
  projectId?: string;
  alias?: string;
  description?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: string;
  auth_type?: string;
  credentials?: Record<string, string>;
  static_headers?: Record<string, string>;
  allowed_tools?: string[];
  blocked_tools?: string[];
  authorization_url?: string;
  token_url?: string;
  registration_url?: string;
  extra_headers?: string[];
}

export interface EditMCPServerRequest {
  server_id: string;
  server_name?: string;
  alias?: string;
  description?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: string;
  auth_type?: string;
  credentials?: Record<string, string>;
  static_headers?: Record<string, string>;
  allowed_tools?: string[];
  blocked_tools?: string[];
  extra_headers?: string[];
}

export interface GatewayMCPServerResponse {
  server_id: string;
  server_name: string;
  alias?: string;
  url?: string;
  transport?: string;
  auth_type?: string;
}

export interface TestConnectionResult {
  success: boolean;
  message: string;
  serverInstructions?: string;
}

export interface MCPToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
}

export interface NormalizedUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatCompletionResult {
  response: string;
  modelName: string;
  usage?: NormalizedUsage;
}

/** Metadata returned after gateway registration (Bifrost stores in model.rateCardOverride._gateway). */
export interface GatewayModelRegistration {
  gatewayProvider?: string;
  keyName?: string;
  keyId?: string;
  credentialId?: string;
  /** Bare upstream provider model id (e.g. catalog or deployment id at onboard). */
  providerModelId?: string;
  /**
   * Upstream provider deployment/inference name when distinct from
   * `providerModelId`. For providers whose Bifrost key config includes a
   * deployment routing map (e.g. `azure_key_config.deployments`), this
   * becomes the map value for `gatewayBindingName`.
   */
  providerDeploymentName?: string;
  /**
   * Unique Bifrost-side routing identifier (`<projectId>__<credShort>__<providerModelId>`).
   * Stored in provider_key.models[], as the deployment-map key (when applicable),
   * as the CEL match target, and in the VK allowed_models entry.
   * Mirrors `Model.gatewayBindingName`.
   */
  gatewayBindingName?: string;
  bifrostTeamId?: string;
  bifrostVirtualKeyId?: string;
}

export interface ILLMGatewayClient {
  isEnabled(): boolean;
  addModel(request: AddModelRequest): Promise<GatewayModelRegistration | void>;
  deleteModel(
    modelId: string,
    options?: {
      gatewayProvider?: string;
      keyName?: string;
      providerModelId?: string;
      /**
       * Unique Bifrost routing identifier when the model was registered
       * under the project__cred__model scheme; deleteModel uses this in
       * preference to providerModelId so it removes the entry that's
       * actually in Bifrost.
       */
      gatewayBindingName?: string;
      credentialId?: string;
      projectId?: string;
      provider?: string;
      /**
       * Decrypted credential secret. Required to trim one model from a
       * multi-model provider key: Bifrost's key PUT is a full replace and
       * blanks the write-only value unless it's re-sent. Without this the
       * stale models[]/aliases entry is left on the key.
       */
      currentApiKey?: string;
    },
  ): Promise<void>;
  /**
   * Run a chat completion through the gateway.
   *
   * The optional `options.apiKey` is a per-call bearer-token override
   * for the gateway. When set, it REPLACES the cluster master key on
   * just this request -- used by per-project callers (e.g. the
   * `POST /models/:id/infer` playground handler) so that team-scoped
   * routing rules and per-project budgets / rate-limits / audit on
   * Bifrost's VK governance actually apply, instead of the shared
   * singleton's cluster master key bypassing all of it. When omitted,
   * the singleton's cluster master key is used (legacy behaviour, only
   * still appropriate for callers that have no project context).
   */
  chatCompletion(
    request: ChatCompletionRequest,
    options?: { apiKey?: string },
  ): Promise<ChatCompletionResult>;
  addMCPServer(request: NewMCPServerRequest): Promise<GatewayMCPServerResponse>;
  editMCPServer(request: EditMCPServerRequest): Promise<void>;
  removeMCPServer(
    serverId: string,
    options?: { projectId?: string; mcpClientName?: string },
  ): Promise<void>;
  listMCPServers(): Promise<GatewayMCPServerResponse[]>;
  testMCPConnection(serverName: string): Promise<TestConnectionResult>;
  listMCPTools(serverName: string): Promise<MCPToolInfo[]>;
  callMCPTool(
    serverName: string,
    toolName: string,
    args: Record<string, any>,
    options?: {
      timeoutMs?: number;
      forwardHeaders?: Record<string, string>;
    },
  ): Promise<any>;
}
