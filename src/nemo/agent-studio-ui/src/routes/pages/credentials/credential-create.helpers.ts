import { normalizeProviderSecretData } from "@/utils/gcpServiceAccountJson";
import { PROVIDER_PRESETS } from "@/constants/providerPresets";
import type { CredentialCreateRequest } from "./credential.types";

/** Drop empty secret values before create/rotate (optional ONTAP fields, etc.). */
export function compactCredentialSecretData(
  secretData: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(secretData)) {
    if (typeof value === "string" && value.trim()) out[key] = value;
  }
  return out;
}

export function parseCredentialLabels(input: string): string[] | undefined {
  const result = input
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  return result.length ? result : undefined;
}

/** Same required-field checks as the Credentials tab create form. */
export function validateCredentialSecretFields(
  provider: string,
  secretData: Record<string, string>,
): string | null {
  const preset = PROVIDER_PRESETS[provider];
  if (preset) {
    const missing = preset.secretFields
      .filter((f) => f.required && !secretData[f.key]?.trim())
      .map((f) => f.label);
    if (missing.length) return `Required fields missing: ${missing.join(", ")}`;
    return null;
  }
  if (!provider.trim()) return "Provider is required";
  const hasAny = Object.entries(secretData).some(([k, v]) => k.trim() && v.trim());
  if (!hasAny) return "Add at least one key/value secret field for this provider";
  return null;
}

/** Whether inline "new credential" inputs are complete enough to test/save. */
export function isCredentialSecretComplete(
  provider: string,
  secretData: Record<string, string>,
): boolean {
  if (!provider.trim()) return false;
  if (provider === "ontap") {
    const hasBasic = Boolean(secretData.username?.trim() && secretData.password?.trim());
    const hasMtls = Boolean(
      secretData.client_cert_pem?.trim() && secretData.client_key_pem?.trim(),
    );
    return hasBasic || hasMtls;
  }
  return validateCredentialSecretFields(provider, secretData) === null;
}

export function credentialSecretCacheKey(
  provider: string,
  name: string,
  secretData: Record<string, string>,
  labels = "",
): string {
  return `${provider}::${name.trim()}::${JSON.stringify(compactCredentialSecretData(secretData))}::${labels.trim()}`;
}

/** Build a POST /credentials body — same path as the Credentials tab. */
export function buildCredentialCreateBody(
  provider: string,
  name: string,
  secretData: Record<string, string>,
  options?: { labels?: string; description?: string },
): { ok: true; body: CredentialCreateRequest } | { ok: false; message: string } {
  if (!name.trim()) return { ok: false, message: "Enter a credential name." };

  const secretErr = validateCredentialSecretFields(provider, secretData);
  if (secretErr) return { ok: false, message: secretErr };

  const normalized = normalizeProviderSecretData(provider, compactCredentialSecretData(secretData));
  if (!normalized.ok) return { ok: false, message: normalized.message };

  return {
    ok: true,
    body: {
      name: name.trim(),
      provider: provider.trim(),
      secretData: normalized.secretData,
      description: options?.description?.trim() || undefined,
      labels: parseCredentialLabels(options?.labels ?? ""),
    },
  };
}
