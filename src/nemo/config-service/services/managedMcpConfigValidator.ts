import { get_logger } from '@agentstudio/observability-client-runtime';
import { getCatalogEntry, MCPServerCatalogEntry } from '../catalog/mcpServerCatalog';
import { getCredentialService } from './CredentialService';

const logger = get_logger();

export type ManagedMcpValidateInput = {
  catalogId: string;
  runtimeCredentialId?: string;
  managedConfig?: {
    resourcePreset?: string;
    envOverrides?: Record<string, string>;
  };
};

export type ManagedMcpValidateResult = {
  success: boolean;
  message: string;
  status: 'connected' | 'error';
};

function validateEnvSchema(
  catalogEntry: MCPServerCatalogEntry,
  envOverrides: Record<string, string>,
): string | null {
  for (const field of catalogEntry.envSchema) {
    if (!field.required) continue;
    const value = envOverrides[field.name]?.trim();
    if (!value) {
      return `${field.name} is required`;
    }
  }
  return null;
}

async function fetchAzureAccessToken(
  tenantId: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://management.azure.com/.default',
  });
  const resp = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
  );
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(
      detail.includes('invalid_client') || resp.status === 401
        ? 'Azure authentication failed — check the runtime credential (tenant, client ID, secret)'
        : `Azure authentication failed (${resp.status})`,
    );
  }
  const json = (await resp.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error('Azure authentication failed — no access token returned');
  }
  return json.access_token;
}

async function validateAnfManagedConfig(
  projectId: string,
  runtimeCredentialId: string,
  envOverrides: Record<string, string>,
): Promise<ManagedMcpValidateResult> {
  const subscriptionId = envOverrides.AZURE_SUBSCRIPTION_ID?.trim();
  const resourceGroup = envOverrides.AZURE_RESOURCE_GROUP?.trim();
  const accountName = envOverrides.ANF_ACCOUNT_NAME?.trim();

  if (!subscriptionId) {
    return { success: false, message: 'AZURE_SUBSCRIPTION_ID is required', status: 'error' };
  }
  if (!resourceGroup) {
    return { success: false, message: 'AZURE_RESOURCE_GROUP is required', status: 'error' };
  }
  if (!accountName) {
    return { success: false, message: 'ANF_ACCOUNT_NAME is required', status: 'error' };
  }

  const secretData = await getCredentialService().readSecretData(projectId, runtimeCredentialId);
  if (!secretData) {
    return { success: false, message: 'Runtime credential secret not found', status: 'error' };
  }

  const tenantId = secretData.tenant_id?.trim();
  const clientId = secretData.client_id?.trim();
  const clientSecret = secretData.client_secret?.trim();
  if (!tenantId || !clientId || !clientSecret) {
    return {
      success: false,
      message: 'Runtime credential is missing tenant_id, client_id, or client_secret',
      status: 'error',
    };
  }

  let accessToken: string;
  try {
    accessToken = await fetchAzureAccessToken(tenantId, clientId, clientSecret);
  } catch (err: any) {
    return { success: false, message: err.message || 'Azure authentication failed', status: 'error' };
  }

  const armUrl =
    `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}` +
    `/resourceGroups/${encodeURIComponent(resourceGroup)}` +
    `/providers/Microsoft.NetApp/netAppAccounts/${encodeURIComponent(accountName)}` +
    '?api-version=2024-01-01';
  const armResp = await fetch(armUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (armResp.status === 404) {
    return {
      success: false,
      message:
        'ANF account not found — check AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP, and ANF_ACCOUNT_NAME',
      status: 'error',
    };
  }
  if (armResp.status === 403) {
    return {
      success: false,
      message:
        'Access denied — the runtime credential lacks permission to read this ANF account',
      status: 'error',
    };
  }
  if (!armResp.ok) {
    return {
      success: false,
      message: `Could not verify ANF account (HTTP ${armResp.status})`,
      status: 'error',
    };
  }
  return {
    success: true,
    message: 'Connected — ANF account verified',
    status: 'connected',
  };
}

async function validateRuntimeCredentialForCatalog(
  projectId: string,
  catalogEntry: MCPServerCatalogEntry,
  runtimeCredentialId?: string,
): Promise<string | null> {
  if (!catalogEntry.credentialMapping) return null;
  if (!runtimeCredentialId?.trim()) {
    return `runtimeCredentialId is required (expected provider: ${catalogEntry.credentialMapping.expectedProvider})`;
  }
  const cred = await getCredentialService().getById(projectId, runtimeCredentialId);
  if (!cred) {
    return `runtimeCredentialId ${runtimeCredentialId} not found in project`;
  }
  if (cred.provider !== catalogEntry.credentialMapping.expectedProvider) {
    return `runtimeCredentialId provider mismatch: credential.provider='${cred.provider}', expected='${catalogEntry.credentialMapping.expectedProvider}'`;
  }
  return null;
}

export async function validateManagedMcpConfig(
  projectId: string,
  input: ManagedMcpValidateInput,
): Promise<ManagedMcpValidateResult> {
  const catalogEntry = getCatalogEntry(input.catalogId);
  if (!catalogEntry) {
    return { success: false, message: `Unknown catalog ID: ${input.catalogId}`, status: 'error' };
  }

  const envOverrides = input.managedConfig?.envOverrides ?? {};

  const credErr = await validateRuntimeCredentialForCatalog(
    projectId,
    catalogEntry,
    input.runtimeCredentialId,
  );
  if (credErr) {
    return { success: false, message: credErr, status: 'error' };
  }

  if (catalogEntry.id === 'anf_mcp' && input.runtimeCredentialId) {
    try {
      return await validateAnfManagedConfig(projectId, input.runtimeCredentialId, envOverrides);
    } catch (err: any) {
      logger.error('[managedMcpConfigValidator] ANF validation error:', err.message);
      return {
        success: false,
        message: err.message || 'ANF connection validation failed',
        status: 'error',
      };
    }
  }

  const schemaErr = validateEnvSchema(catalogEntry, envOverrides);
  if (schemaErr) {
    return { success: false, message: schemaErr, status: 'error' };
  }

  // Catalogs without a live probe: schema + credential mapping checks passed.
  return {
    success: true,
    message: 'Configuration validated',
    status: 'connected',
  };
}
