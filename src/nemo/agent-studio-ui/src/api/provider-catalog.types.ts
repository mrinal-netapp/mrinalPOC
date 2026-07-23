/** Mirrors config-service ProviderCatalogService / provider-catalog.json. */

export type ConnectorScope = "account" | "resource";

export interface ProviderConfigProperty {
  type: string;
  description?: string;
  format?: string;
}

export interface ProviderConfigSchemaScope {
  required: string[];
  optional: string[];
  properties: Record<string, ProviderConfigProperty>;
}

export interface ProviderCatalogEntry {
  id: string;
  label: string;
  scopes: ConnectorScope[];
  supportedActions: string[];
  supportedNodeTypes: string[];
  connectorConfigSchema: Partial<Record<ConnectorScope, ProviderConfigSchemaScope>>;
  hasAcquisition: boolean;
  hasRegionSelector?: boolean;
}

export interface ProviderCatalogListResponse {
  providers: ProviderCatalogEntry[];
}
