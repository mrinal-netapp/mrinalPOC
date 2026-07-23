import { ProviderAdapter, ProviderModel } from './types';
import { OpenAIAdapter } from './openai';
import { OpenAICompatibleAdapter } from './openai_compatible';
import { AWSBedrockAdapter } from './aws_bedrock';
import { AzureAdapter } from './azure';
import { GoogleAdapter } from './google';
import { GeminiAdapter } from './gemini';
import { AnthropicAdapter } from './anthropic';
import { OllamaAdapter } from './ollama';
import { CohereAdapter } from './cohere';
import { PerplexityAdapter } from './perplexity';
import { HuggingFaceAdapter } from './huggingface';
import { FireworksAdapter } from './fireworks';
import { createConnectorAdapters } from './connector';

/**
 * Registry for all provider adapters.
 * Maps provider key → adapter instance.
 */
export class ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>();

  constructor() {
    this.register(new OpenAIAdapter());
    this.register(new OpenAICompatibleAdapter());
    this.register(new AWSBedrockAdapter());
    this.register(new AzureAdapter());
    this.register(new GoogleAdapter());
    this.register(new GeminiAdapter());
    this.register(new AnthropicAdapter());
    this.register(new OllamaAdapter());
    this.register(new CohereAdapter());
    this.register(new PerplexityAdapter());
    this.register(new HuggingFaceAdapter());
    this.register(new FireworksAdapter());
    for (const adapter of createConnectorAdapters()) {
      this.register(adapter);
    }
  }

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  get(provider: string): ProviderAdapter | undefined {
    return this.adapters.get(provider);
  }

  has(provider: string): boolean {
    return this.adapters.has(provider);
  }

  listProviders(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Validate credentials for a given provider.
   */
  async validate(
    provider: string,
    credentials: Record<string, string>,
    metadata?: Record<string, any>
  ): Promise<boolean> {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      // Unknown providers are allowed for generic credential storage.
      // Skip strict validation when no adapter is registered.
      return true;
    }
    return adapter.validate(credentials, metadata);
  }

  /**
   * List available models from a provider.
   */
  async listModels(
    provider: string,
    credentials: Record<string, string>,
    metadata?: Record<string, any>,
    modelType?: 'llm' | 'embedding'
  ): Promise<ProviderModel[]> {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`Unknown provider: ${provider}`);
    }
    return adapter.listModels(credentials, metadata, modelType);
  }
}

/** Singleton instance */
let instance: ProviderRegistry | null = null;

export function getProviderRegistry(): ProviderRegistry {
  if (!instance) {
    instance = new ProviderRegistry();
  }
  return instance;
}
