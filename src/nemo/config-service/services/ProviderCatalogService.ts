import * as fs from 'fs';
import * as path from 'path';
import { isIP } from 'net';

export interface ProviderConfigProperty {
  type: string;
  description?: string;
  // Optional value-format constraint enforced by validateConnectorConfig.
  // Currently only 'cidr' is recognised (validates array/comma-string entries
  // as IPv4/IPv6 CIDRs).
  format?: string;
}

export interface ProviderConfigSchemaScope {
  required: string[];
  optional: string[];
  properties: Record<string, ProviderConfigProperty>;
}

export interface DataAccessModel {
  rootAction: string;
  selectionMode: 'single' | 'multi';
  selectableTypes: string[];
  queryEditor?: { language: string };
}

export interface ProviderCatalogEntry {
  id: string;
  label: string;
  scopes: ('account' | 'resource')[];
  supportedActions: string[];
  supportedNodeTypes: string[];
  connectorConfigSchema: Record<string, ProviderConfigSchemaScope>;
  hasAcquisition: boolean;
  hasRegionSelector?: boolean;
  dataAccessModel?: DataAccessModel;
  resourceSelectorSchema?: Record<string, unknown>;
}

let catalog: ProviderCatalogEntry[] | null = null;

function loadCatalog(): ProviderCatalogEntry[] {
  if (catalog) return catalog;
  const catalogPath = path.resolve(__dirname, '..', 'provider-catalog.json');
  const raw = fs.readFileSync(catalogPath, 'utf-8');
  catalog = JSON.parse(raw) as ProviderCatalogEntry[];
  return catalog;
}

export function getAllProviders(): ProviderCatalogEntry[] {
  return loadCatalog();
}

export function getProvider(providerId: string): ProviderCatalogEntry | undefined {
  return loadCatalog().find((p) => p.id === providerId);
}

export function getProviderIds(): string[] {
  return loadCatalog().map((p) => p.id);
}

/**
 * True when `value` is a well-formed IPv4 or IPv6 CIDR (address + prefix, e.g.
 * `10.0.0.0/16` or `2001:db8::/48`). Uses the stdlib `net.isIP` for the address
 * part so no dependency is needed. A bare address without `/prefix` is rejected
 * — that's the exact bug this guards (e.g. `10.0.0.1`).
 */
function isValidCidr(value: string): boolean {
  const slash = value.indexOf('/');
  if (slash === -1) return false;
  const address = value.slice(0, slash);
  const prefixStr = value.slice(slash + 1);
  const family = isIP(address); // 4, 6, or 0 (invalid)
  if (family === 0) return false;
  if (!/^\d+$/.test(prefixStr)) return false;
  const prefix = Number(prefixStr);
  const maxPrefix = family === 4 ? 32 : 128;
  return prefix >= 0 && prefix <= maxPrefix;
}

/**
 * Coerce a connector-config field value into the list of CIDR strings to
 * validate. Accepts both the declared array form and the comma-separated
 * string form the ONTAP adapter also tolerates.
 */
function cidrEntries(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean);
  return [];
}

export function validateConnectorConfig(
  provider: string,
  scope: 'account' | 'resource',
  config: Record<string, unknown>,
): { valid: boolean; errors: string[] } {
  const entry = getProvider(provider);
  if (!entry) {
    return { valid: false, errors: [`Unknown provider: ${provider}`] };
  }
  if (!entry.scopes.includes(scope)) {
    return { valid: false, errors: [`Provider ${provider} does not support scope ${scope}`] };
  }
  const schemaForScope = entry.connectorConfigSchema[scope];
  if (!schemaForScope) {
    return { valid: false, errors: [`No config schema for provider ${provider} scope ${scope}`] };
  }

  const errors: string[] = [];
  for (const field of schemaForScope.required) {
    if (config[field] === undefined || config[field] === null || config[field] === '') {
      errors.push(`${field} is required for ${provider} (scope=${scope})`);
    }
  }

  const allFields = new Set([...schemaForScope.required, ...schemaForScope.optional]);
  for (const key of Object.keys(config)) {
    if (!allFields.has(key)) {
      errors.push(`Unknown field '${key}' for provider ${provider} (scope=${scope})`);
    }
  }

  // Enforce value-format constraints declared on the catalog properties. Only
  // fields actually present are checked (absence/optionality is handled above).
  for (const [key, prop] of Object.entries(schemaForScope.properties)) {
    const value = config[key];
    if (value === undefined || value === null || value === '') continue;
    if (prop.format === 'cidr') {
      // Reject non-array/non-string values outright — a number/object can't be
      // a CIDR list and would otherwise pass silently (cidrEntries returns []).
      if (!Array.isArray(value) && typeof value !== 'string') {
        errors.push(`${key} must be an array of CIDR strings for ${provider} (scope=${scope})`);
        continue;
      }
      for (const cidr of cidrEntries(value)) {
        if (!isValidCidr(cidr)) {
          errors.push(
            `${key} entry '${cidr}' is not a valid CIDR (expected e.g. 10.0.0.0/16 or 2001:db8::/48)`,
          );
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function reloadCatalog(): void {
  catalog = null;
  loadCatalog();
}
