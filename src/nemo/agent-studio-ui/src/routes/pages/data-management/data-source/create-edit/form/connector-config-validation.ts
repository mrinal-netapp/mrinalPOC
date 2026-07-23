import type { ConnectorConfig } from "@/api/data-source.types";
import type {
  ConnectorScope,
  ProviderCatalogEntry,
  ProviderConfigSchemaScope,
} from "@/api/provider-catalog.types";

/** Catalog id for S3-compatible object stores (MinIO, custom endpoints). Runtime provider stays `s3`. */
export const S3_COMPATIBLE_CATALOG_PROVIDER = "s3_compatible";

/**
 * Picks which provider-catalog entry drives required-field markers for the
 * Object store tab. S3Compatible and CustomObjectStore+S3 use `s3_compatible`;
 * Amazon S3 keeps the native `s3` schema (bucket only).
 */
export function resolveObjectStoreCatalogProvider(
  osSubType: string,
  osProvider: string,
  osResolvedProvider: string,
): string {
  if (
    osSubType === "S3Compatible" ||
    (osSubType === "CustomObjectStore" && osProvider === "S3")
  ) {
    return S3_COMPATIBLE_CATALOG_PROVIDER;
  }
  return osResolvedProvider;
}

/** Drop empty/undefined entries — same rules as access-config-dialog compactConfig. */
export function compactConfig(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (typeof value === "number" && Number.isNaN(value)) continue;
    out[key] = value;
  }
  return out;
}

const CONNECTOR_CONFIG_STRUCTURAL_KEYS = new Set([
  "scope",
  "provider",
  "connector_type",
  "database_type",
]);

/**
 * Connector_config updates are shallow-merged on the backend, so keys omitted
 * from the patch are never removed. Re-emit cleared optional fields as null.
 */
export function withClearedConnectorConfigFields(
  next: ConnectorConfig,
  previous: ConnectorConfig | undefined,
): ConnectorConfig {
  if (!previous) return next;
  const out = { ...next };
  for (const [key, value] of Object.entries(previous)) {
    if (CONNECTOR_CONFIG_STRUCTURAL_KEYS.has(key)) continue;
    if (!(key in next) && value !== undefined && value !== null && value !== "") {
      out[key] = null;
    }
  }
  return out;
}

export function getSchemaForProvider(
  catalog: ProviderCatalogEntry[] | undefined,
  providerId: string | undefined,
  scope: ConnectorScope | undefined,
): ProviderConfigSchemaScope | undefined {
  if (!catalog?.length || !providerId || !scope) return undefined;
  const entry = catalog.find((p) => p.id === providerId);
  return entry?.connectorConfigSchema[scope];
}

export function getRequiredFields(
  catalog: ProviderCatalogEntry[] | undefined,
  providerId: string | undefined,
  scope: ConnectorScope | undefined,
): string[] {
  return getSchemaForProvider(catalog, providerId, scope)?.required ?? [];
}

export function getRequiredFieldSet(
  catalog: ProviderCatalogEntry[] | undefined,
  providerId: string | undefined,
  scope: ConnectorScope | undefined,
): Set<string> {
  return new Set(getRequiredFields(catalog, providerId, scope));
}

/** Matches backend validateConnectorConfig empty/required checks. */
export function areCatalogRequiredFieldsFilled(
  required: readonly string[],
  config: Record<string, unknown>,
): boolean {
  return required.every((field) => {
    const value = config[field];
    if (value === undefined || value === null) return false;
    if (typeof value === "string") return value.trim() !== "";
    if (typeof value === "number") return !Number.isNaN(value);
    return true;
  });
}

export function isConnectorCategoryReady(
  catalog: ProviderCatalogEntry[] | undefined,
  providerId: string | undefined,
  scope: ConnectorScope | undefined,
  config: Record<string, unknown>,
  credsComplete: boolean,
): boolean {
  if (!credsComplete) return false;
  const schema = getSchemaForProvider(catalog, providerId, scope);
  if (!schema) return false;
  return areCatalogRequiredFieldsFilled(schema.required, config);
}

export function isCatalogLoaded(
  catalog: ProviderCatalogEntry[] | undefined,
  isLoading: boolean,
  isError: boolean,
): boolean {
  return !isLoading && !isError && Array.isArray(catalog) && catalog.length > 0;
}
