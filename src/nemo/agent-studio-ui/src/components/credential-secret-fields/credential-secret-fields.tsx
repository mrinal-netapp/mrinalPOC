import { useRef, useState, type ReactElement } from "react";
import { IconPlus, IconUpload, IconX } from "@tabler/icons-react";

import { Input } from "@/ui-lib/base-components/input/input";
import { Button } from "@/ui-lib/base-components/button/button";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import {
  GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES,
  validateGcpServiceAccountJson,
} from "@/utils/gcpServiceAccountJson";
import type { ProviderSecretField } from "@/constants/providerPresets";
import { PROVIDER_PRESETS } from "@/constants/providerPresets";
import "./credential-secret-fields.scss";

// -- Types --

interface CredentialSecretFieldsProps {
  provider: string;
  secretData: Record<string, string>;
  onChange: (secretData: Record<string, string>) => void;
  metadata?: Record<string, string>;
  onMetadataChange?: (metadata: Record<string, string>) => void;
  disabled?: boolean;
}

// -- Helpers --

function updateField(
  current: Record<string, string>,
  key: string,
  value: string,
  onChange: (d: Record<string, string>) => void,
): void {
  onChange({ ...current, [key]: value });
}

// -- Sub-component: label row that mirrors input-wrapper__label-area --

interface FieldLabelProps {
  label: string;
  required?: boolean;
  htmlFor?: string;
}

function FieldLabel({ label, required, htmlFor }: FieldLabelProps): ReactElement {
  return (
    <div className="credential-secret-fields__label-area">
      <Typography
        Component="label"
        htmlFor={htmlFor}
        fontSize="fs14"
        boldness="regular"
        className="credential-secret-fields__label"
      >
        {label}
      </Typography>
      {!required && (
        <Typography
          Component="span"
          fontSize="fs14"
          boldness="regular"
          color="var(--text-secondary)"
        >
          Optional
        </Typography>
      )}
    </div>
  );
}

// -- Sub-component: service account JSON field with file upload --

interface ServiceAccountJsonSecretFieldProps {
  field: ProviderSecretField;
  value: string;
  disabled?: boolean;
  onChange: (next: string) => void;
}

function ServiceAccountJsonSecretField({
  field,
  value,
  disabled,
  onChange,
}: ServiceAccountJsonSecretFieldProps): ReactElement {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileFeedback, setFileFeedback] = useState<{
    intent: "success" | "error";
    message: string;
  } | null>(null);

  const handleFile = async (file: File | undefined): Promise<void> => {
    setFileFeedback(null);
    if (!file) return;

    if (file.size > GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES) {
      setFileFeedback({
        intent: "error",
        message: `File is too large (${file.size.toLocaleString()} bytes). Maximum is ${GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES.toLocaleString()} bytes (${GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES / 1024} KiB).`,
      });
      return;
    }

    let text: string;
    try {
      text = await file.text();
    } catch {
      setFileFeedback({ intent: "error", message: "Could not read the file." });
      return;
    }

    const result = validateGcpServiceAccountJson(text);
    if (!result.ok) {
      setFileFeedback({ intent: "error", message: result.message });
      return;
    }

    const parsed = JSON.parse(result.normalized) as { client_email?: string };
    const pretty = JSON.stringify(parsed, null, 2);
    onChange(pretty);

    setFileFeedback({
      intent: "success",
      message: `Loaded ${file.name} — ${typeof parsed.client_email === "string" ? parsed.client_email : "service account"}`,
    });
  };

  return (
    <div className="credential-secret-fields__json-field">
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="credential-secret-fields__file-input"
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0];
          void handleFile(f);
          e.target.value = "";
        }}
      />
      <div className="credential-secret-fields__upload-row">
        <Button
          variant="outline"
          size="small"
          icon={<IconUpload size={16} />}
          label="Upload JSON file"
          isDisabled={disabled}
          onClick={() => fileInputRef.current?.click()}
        />
        <Typography Component="span" fontSize="fs13" boldness="regular" color="var(--text-secondary)">
          Max {GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES / 1024} KiB · IAM service account key JSON only
        </Typography>
      </div>
      <textarea
        className="credential-secret-fields__textarea credential-secret-fields__textarea--mono"
        value={value}
        onChange={(e) => {
          setFileFeedback(null);
          onChange(e.target.value);
        }}
        placeholder={field.placeholder}
        disabled={disabled}
        rows={8}
      />
      {fileFeedback && (
        <Typography
          Component="span"
          fontSize="fs13"
          boldness="regular"
          color={
            fileFeedback.intent === "success"
              ? "var(--notification-success)"
              : "var(--notification-error)"
          }
        >
          {fileFeedback.message}
        </Typography>
      )}
    </div>
  );
}

// -- Main component --

function CredentialSecretFields({
  provider,
  secretData,
  onChange,
  metadata,
  onMetadataChange,
  disabled = false,
}: CredentialSecretFieldsProps): ReactElement {
  const preset = PROVIDER_PRESETS[provider];
  const hasDynamicRows = !preset;

  const dynamicRows = Object.entries(secretData);

  const addDynamicSecretField = (): void => {
    let index = dynamicRows.length + 1;
    while (Object.prototype.hasOwnProperty.call(secretData, `field_${index}`)) {
      index++;
    }
    onChange({ ...secretData, [`field_${index}`]: "" });
  };

  const renameDynamicKey = (oldKey: string, newKey: string): void => {
    const trimmed = newKey.trim();
    if (!trimmed || trimmed === oldKey) return;
    if (Object.prototype.hasOwnProperty.call(secretData, trimmed)) return;
    const next = { ...secretData };
    const value = next[oldKey];
    delete next[oldKey];
    next[trimmed] = value;
    onChange(next);
  };

  const removeDynamicKey = (key: string): void => {
    const next = { ...secretData };
    delete next[key];
    onChange(next);
  };

  return (
    <div className="credential-secret-fields">
      {preset ? (
        <>
          {preset.secretFields.map((field) => (
            <div key={field.key} className="credential-secret-fields__field-group">
              {field.jsonFileUpload ? (
                <>
                  <FieldLabel label={field.label} required={field.required} />
                  <ServiceAccountJsonSecretField
                    field={field}
                    value={secretData[field.key] ?? ""}
                    disabled={disabled}
                    onChange={(next) => updateField(secretData, field.key, next, onChange)}
                  />
                </>
              ) : field.multiline ? (
                <>
                  <FieldLabel label={field.label} required={field.required} />
                  <textarea
                    className="credential-secret-fields__textarea credential-secret-fields__textarea--mono"
                    value={secretData[field.key] ?? ""}
                    onChange={(e) =>
                      updateField(secretData, field.key, e.target.value, onChange)
                    }
                    placeholder={field.placeholder}
                    disabled={disabled}
                    rows={6}
                  />
                </>
              ) : (
                <Input
                  label={field.label}
                  isOptional={!field.required}
                  type={field.type === "password" ? "password" : "text"}
                  value={secretData[field.key] ?? ""}
                  onChange={(e) =>
                    updateField(secretData, field.key, e.target.value, onChange)
                  }
                  placeholder={field.placeholder}
                  isDisabled={disabled}
                />
              )}
            </div>
          ))}

          {preset.metadataFields && onMetadataChange && (
            <>
              <Typography
                Component="p"
                fontSize="fs14"
                boldness="semibold"
                className="credential-secret-fields__section-title"
              >
                Configuration
              </Typography>
              {preset.metadataFields.map((field) => (
                <div key={field.key} className="credential-secret-fields__field-group">
                  <Input
                    label={field.label}
                    isOptional={!field.required}
                    value={metadata?.[field.key] ?? ""}
                    onChange={(e) =>
                      onMetadataChange({ ...(metadata ?? {}), [field.key]: e.target.value })
                    }
                    placeholder={field.placeholder}
                    isDisabled={disabled}
                  />
                </div>
              ))}
            </>
          )}
        </>
      ) : (
        <>
          <Typography Component="p" fontSize="fs13" boldness="regular" color="var(--text-secondary)">
            This provider has no preset secret schema. Add key/value fields manually.
          </Typography>
          {dynamicRows.map(([key, value]) => (
            <div key={key} className="credential-secret-fields__dynamic-row">
              <Input
                defaultValue={key}
                placeholder="Key"
                isDisabled={disabled}
                onBlur={(e) => renameDynamicKey(key, (e.target as HTMLInputElement).value)}
              />
              <Input
                type="password"
                value={value}
                onChange={(e) => updateField(secretData, key, e.target.value, onChange)}
                placeholder="Value"
                isDisabled={disabled}
              />
              <Button
                variant="icon"
                icon={<IconX size={16} />}
                isDisabled={disabled}
                onClick={() => removeDynamicKey(key)}
                aria-label={`Remove ${key}`}
              />
            </div>
          ))}
          <Button
            variant="flat"
            size="small"
            icon={<IconPlus size={16} />}
            label="Add field"
            isDisabled={disabled}
            onClick={addDynamicSecretField}
          />
        </>
      )}

      {!provider && (
        <Typography Component="p" fontSize="fs13" boldness="regular" color="var(--text-secondary)">
          Select a provider to see or define secret fields.
        </Typography>
      )}

      {hasDynamicRows && dynamicRows.length === 0 && (
        <Typography Component="p" fontSize="fs13" boldness="regular" color="var(--text-secondary)">
          No secret fields added yet.
        </Typography>
      )}
    </div>
  );
}

export { CredentialSecretFields };
export type { CredentialSecretFieldsProps };
