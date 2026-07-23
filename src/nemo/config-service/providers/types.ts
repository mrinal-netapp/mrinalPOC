/**
 * Normalized model item returned by provider adapters.
 */
export interface ProviderModel {
  id: string;
  name: string;
  type: 'llm' | 'embedding';
  description?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsExtendedOutput?: boolean;
  /**
   * Vector dimensions for `type === 'embedding'` models. Populated by
   * modelRoutes.POST /list-available from the static catalog in
   * `providers/embeddingDimensions.ts`. Used by the RegisterModelWizard
   * to prefill its "Dimensions" input so the user can confirm or
   * override before persisting.
   */
  dimensions?: number;
  rateCard?: {
    inputPricePerToken?: number;
    outputPricePerToken?: number;
    currency?: string;
  };
  metadata?: Record<string, any>;
}

/**
 * Interface every provider adapter must implement.
 */
export interface ProviderAdapter {
  /** Provider key (e.g. 'openai', 'aws_bedrock') */
  readonly provider: string;

  /** Expected secret keys for this provider (e.g. ['api_key']) */
  readonly expectedSecretKeys: string[];

  /**
   * Validate that the credential can reach the provider.
   * @returns true if valid, false otherwise
   */
  validate(
    credentials: Record<string, string>,
    metadata?: Record<string, any>
  ): Promise<boolean>;

  /**
   * List models available from this provider.
   * @param credentials - Decoded secret data
   * @param metadata - Provider-specific config (region, endpoint, etc.)
   * @param modelType - Optional filter by type
   */
  listModels(
    credentials: Record<string, string>,
    metadata?: Record<string, any>,
    modelType?: 'llm' | 'embedding'
  ): Promise<ProviderModel[]>;
}
