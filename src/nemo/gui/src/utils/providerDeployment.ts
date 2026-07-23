import type { ProviderModel } from '../services/api'

export const PROVIDER_DEPLOYMENT_COLUMN_LABEL = 'Provider deployment'

/** Default upstream deployment/inference id from discovery metadata or model id. */
export function defaultProviderDeploymentName(model: ProviderModel): string {
  const meta = (model.metadata as Record<string, unknown> | undefined) || {}
  const explicit = meta.deployment
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  return model.id
}

/**
 * Value sent as `providerDeploymentName` when it differs from `providerModelId`.
 * Omitting when equal keeps identity routing for providers that use model id directly.
 */
export function resolveProviderDeploymentName(
  model: ProviderModel,
  deploymentName?: string,
): string | undefined {
  const resolved = deploymentName?.trim() || defaultProviderDeploymentName(model)
  return resolved !== model.id ? resolved : undefined
}
