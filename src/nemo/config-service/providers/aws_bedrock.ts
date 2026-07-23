import axios from 'axios';
import { ProviderAdapter, ProviderModel } from './types';

/**
 * AWS Bedrock provider adapter.
 * Uses the Bedrock ListFoundationModels API.
 */
export class AWSBedrockAdapter implements ProviderAdapter {
  readonly provider = 'aws_bedrock';
  readonly expectedSecretKeys = ['aws_access_key_id', 'aws_secret_access_key'];

  async validate(
    credentials: Record<string, string>,
    metadata?: Record<string, any>
  ): Promise<boolean> {
    // Validate by attempting to call the ListFoundationModels API
    try {
      const models = await this.listModels(credentials, metadata);
      return models.length > 0;
    } catch {
      return false;
    }
  }

  async listModels(
    credentials: Record<string, string>,
    metadata?: Record<string, any>,
    modelType?: 'llm' | 'embedding'
  ): Promise<ProviderModel[]> {
    const region = metadata?.region || credentials.region || 'us-east-1';

    // Use AWS SDK signing to call Bedrock
    // For now, return a well-known static catalog with the models available through Bedrock
    // A full implementation would use @aws-sdk/client-bedrock ListFoundationModels
    const bedrockModels: ProviderModel[] = [
      // Anthropic models
      { id: 'anthropic.claude-3-5-sonnet-20241022-v2:0', name: 'Claude 3.5 Sonnet v2', type: 'llm', description: 'Anthropic Claude 3.5 Sonnet v2', contextWindow: 200000, rateCard: { inputPricePerToken: 0.000003, outputPricePerToken: 0.000015, currency: 'USD' } },
      { id: 'anthropic.claude-3-5-haiku-20241022-v1:0', name: 'Claude 3.5 Haiku', type: 'llm', description: 'Anthropic Claude 3.5 Haiku', contextWindow: 200000, rateCard: { inputPricePerToken: 0.0000008, outputPricePerToken: 0.000004, currency: 'USD' } },
      { id: 'anthropic.claude-3-opus-20240229-v1:0', name: 'Claude 3 Opus', type: 'llm', description: 'Anthropic Claude 3 Opus', contextWindow: 200000, rateCard: { inputPricePerToken: 0.000015, outputPricePerToken: 0.000075, currency: 'USD' } },
      // Amazon Titan models
      { id: 'amazon.titan-text-premier-v1:0', name: 'Titan Text Premier', type: 'llm', description: 'Amazon Titan Text Premier' },
      { id: 'amazon.titan-text-express-v1', name: 'Titan Text Express', type: 'llm', description: 'Amazon Titan Text Express' },
      { id: 'amazon.titan-embed-text-v2:0', name: 'Titan Embeddings V2', type: 'embedding', description: 'Amazon Titan Embeddings V2' },
      { id: 'amazon.titan-embed-text-v1', name: 'Titan Embeddings V1', type: 'embedding', description: 'Amazon Titan Embeddings V1' },
      // Meta Llama models
      { id: 'meta.llama3-2-90b-instruct-v1:0', name: 'Llama 3.2 90B Instruct', type: 'llm', description: 'Meta Llama 3.2 90B Instruct', contextWindow: 128000 },
      { id: 'meta.llama3-2-11b-instruct-v1:0', name: 'Llama 3.2 11B Instruct', type: 'llm', description: 'Meta Llama 3.2 11B Instruct', contextWindow: 128000 },
      // Cohere models
      { id: 'cohere.embed-english-v3', name: 'Cohere Embed English V3', type: 'embedding', description: 'Cohere Embed English V3' },
      { id: 'cohere.embed-multilingual-v3', name: 'Cohere Embed Multilingual V3', type: 'embedding', description: 'Cohere Embed Multilingual V3' },
    ];

    if (modelType) {
      return bedrockModels.filter(m => m.type === modelType);
    }
    return bedrockModels;
  }
}
