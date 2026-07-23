/** Max decoded UTF-8 size for uploaded service account JSON (generous vs typical ~2–4 KiB keys). */
export const GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES = 64 * 1024

export type ValidateGcpServiceAccountJsonResult =
  | { ok: true; normalized: string }
  | { ok: false; message: string }

/**
 * Validates a Google Cloud service account key JSON document (download from IAM).
 * Returns minified JSON suitable for storing as a credential secret.
 */
export function validateGcpServiceAccountJson(raw: string): ValidateGcpServiceAccountJsonResult {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { ok: false, message: 'File is empty.' }
  }

  const byteLength = new TextEncoder().encode(trimmed).length
  if (byteLength > GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES) {
    return {
      ok: false,
      message: `JSON is too large (${byteLength} bytes). Maximum allowed is ${GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES} bytes.`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, message: 'Invalid JSON — check the file is valid UTF-8 JSON.' }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'JSON must be a single object, not an array or primitive.' }
  }

  const o = parsed as Record<string, unknown>

  if (o.type !== 'service_account') {
    return {
      ok: false,
      message: 'Not a GCP service account key: expected "type": "service_account".',
    }
  }

  const stringFields = ['project_id', 'private_key_id', 'private_key', 'client_email'] as const
  for (const key of stringFields) {
    const v = o[key]
    if (typeof v !== 'string' || !v.trim()) {
      return { ok: false, message: `Missing or invalid required field: ${key}` }
    }
  }

  const clientEmail = o.client_email as string
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
    return { ok: false, message: 'client_email is not a valid email address.' }
  }

  const privateKey = o.private_key as string
  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    return { ok: false, message: 'private_key must be a PEM-encoded private key (expect BEGIN PRIVATE KEY).' }
  }

  return { ok: true, normalized: JSON.stringify(parsed) }
}

/** Providers that store GCP service account key JSON under `service_account_json`. */
const GCP_SA_JSON_PROVIDERS = new Set(['gcp', 'gcs'])

/**
 * Validates and minifies service account JSON for known GCP-related credential providers.
 * Other providers pass through unchanged.
 */
export function normalizeProviderSecretData(
  provider: string,
  secretData: Record<string, string>,
): { ok: true; secretData: Record<string, string> } | { ok: false; message: string } {
  if (!GCP_SA_JSON_PROVIDERS.has(provider)) {
    return { ok: true, secretData }
  }
  const raw = secretData.service_account_json
  if (!raw?.trim()) {
    return { ok: false, message: 'Service Account JSON is required.' }
  }
  const result = validateGcpServiceAccountJson(raw)
  if (!result.ok) {
    return { ok: false, message: result.message }
  }
  return {
    ok: true,
    secretData: { ...secretData, service_account_json: result.normalized },
  }
}
