import axios from 'axios';
import { ProviderAdapter, ProviderModel } from './types';

/** Default Azure OpenAI REST api-version when credential metadata omits it. */
export const AZURE_OPENAI_DEFAULT_API_VERSION = '2023-03-15-preview';

/**
 * Azure OpenAI provider adapter.
 *
 * listModels: for the credential's api_version,
 *   1) GET /openai/deployments — deployed models only (works with e.g. 2023-03-15-preview)
 *   2) else GET /openai/models — regional catalog (all provider model types)
 *
 * Chat/inference uses the same api_version (e.g. 2025-01-01-preview).
 */
export class AzureAdapter implements ProviderAdapter {
  readonly provider = 'azure';
  readonly expectedSecretKeys = ['api_key'];

  private apiVersion(metadata?: Record<string, any>): string {
    return metadata?.api_version || metadata?.apiVersion || AZURE_OPENAI_DEFAULT_API_VERSION;
  }

  private azureHeaders(apiKey: string): Record<string, string> {
    return { 'api-key': apiKey };
  }

  /** Optional comma-separated deployment names from Azure portal (skips API discovery). */
  private parseManualDeployments(metadata?: Record<string, any>): ProviderModel[] | null {
    const raw = metadata?.deployment_names ?? metadata?.deploymentNames;
    if (!raw) return null;

    const names = (typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw : [])
      .map((s) => String(s).trim())
      .filter(Boolean);

    if (names.length === 0) return null;

    return names.map((deploymentName) => ({
      id: deploymentName,
      name: deploymentName,
      type: deploymentName.includes('embedding') ? 'embedding' : 'llm',
      description: `Azure deployment ${deploymentName}`,
      metadata: { deployment: deploymentName, source: 'manual_deployment_names' },
    })) as ProviderModel[];
  }

  private mapDeploymentRows(data: unknown[]): ProviderModel[] {
    return data
      .filter((d: any) => !d.status || d.status === 'succeeded')
      .map((d: any) => {
        const deploymentName = (d.id || d.name) as string;
        const underlyingModel = (d.model || deploymentName) as string;
        const isEmbedding = underlyingModel.includes('embedding');
        return {
          id: deploymentName,
          name: deploymentName,
          type: isEmbedding ? 'embedding' : 'llm',
          description: `Azure deployment ${deploymentName} (${underlyingModel})`,
          metadata: {
            deployment: deploymentName,
            model: underlyingModel,
            status: d.status,
            source: 'deployments_api',
          },
        } as ProviderModel;
      });
  }

  private mapCatalogRows(data: unknown[]): ProviderModel[] {
    return (data || []).map((m: any) => {
      const id = m.id as string;
      const isEmbedding = id.includes('embedding');
      return {
        id,
        name: id,
        type: isEmbedding ? 'embedding' : 'llm',
        description: `Azure model type ${id} (regional catalog)`,
        metadata: { capabilities: m.capabilities, source: 'models_catalog' },
      } as ProviderModel;
    });
  }

  private filterByType(models: ProviderModel[], modelType?: 'llm' | 'embedding'): ProviderModel[] {
    return modelType ? models.filter((m) => m.type === modelType) : models;
  }

  /** GET /openai/deployments for the given api-version; null if unavailable. */
  private async tryListDeployments(
    endpoint: string,
    headers: Record<string, string>,
    apiVersion: string,
  ): Promise<ProviderModel[] | null> {
    try {
      const response = await axios.get(
        `${endpoint}/openai/deployments?api-version=${apiVersion}`,
        { headers, timeout: 15000 },
      );
      const rows = response.data?.data;
      if (!Array.isArray(rows)) return null;
      console.log(
        `[AzureAdapter] using deployed models from GET /openai/deployments?api-version=${apiVersion} (${rows.length} rows)`,
      );
      return this.mapDeploymentRows(rows);
    } catch (err: any) {
      const status = err.response?.status;
      const msg = err.response?.data?.error?.message || err.message;
      console.log(
        `[AzureAdapter] GET /openai/deployments api-version=${apiVersion} not used (${status ?? 'error'}: ${msg})`,
      );
      return null;
    }
  }

  /** GET /openai/models regional catalog for the given api-version. */
  private async listCatalog(
    endpoint: string,
    headers: Record<string, string>,
    apiVersion: string,
  ): Promise<ProviderModel[]> {
    const response = await axios.get(
      `${endpoint}/openai/models?api-version=${apiVersion}`,
      { headers, timeout: 15000 },
    );
    console.log(
      `[AzureAdapter] using regional catalog from GET /openai/models?api-version=${apiVersion}`,
    );
    return this.mapCatalogRows(response.data?.data || []);
  }

  async validate(
    credentials: Record<string, string>,
    metadata?: Record<string, any>
  ): Promise<boolean> {
    const apiKey = credentials.api_key;
    const endpoint = metadata?.endpoint;
    if (!apiKey || !endpoint) return false;

    const apiVersion = this.apiVersion(metadata);
    const headers = this.azureHeaders(apiKey);

    if (this.parseManualDeployments(metadata)?.length) return true;

    const deployed = await this.tryListDeployments(endpoint, headers, apiVersion);
    if (deployed && deployed.length > 0) return true;

    try {
      await this.listCatalog(endpoint, headers, apiVersion);
      return true;
    } catch {
      return false;
    }
  }

  async listModels(
    credentials: Record<string, string>,
    metadata?: Record<string, any>,
    modelType?: 'llm' | 'embedding'
  ): Promise<ProviderModel[]> {
    const apiKey = credentials.api_key;
    const endpoint = metadata?.endpoint;
    if (!apiKey || !endpoint) throw new Error('Missing api_key or endpoint for Azure');

    const apiVersion = this.apiVersion(metadata);
    const headers = this.azureHeaders(apiKey);

    const manual = this.parseManualDeployments(metadata);
    if (manual?.length) {
      return this.filterByType(manual, modelType);
    }

    const deployed = await this.tryListDeployments(endpoint, headers, apiVersion);
    if (deployed && deployed.length > 0) {
      return this.filterByType(deployed, modelType);
    }

    try {
      const catalog = await this.listCatalog(endpoint, headers, apiVersion);
      return this.filterByType(catalog, modelType);
    } catch (err: any) {
      const detail = err.response?.data?.error?.message || err.message;
      throw new Error(
        `Failed to list models from ${endpoint} (api-version=${apiVersion}). ${detail}`,
      );
    }
  }
}
