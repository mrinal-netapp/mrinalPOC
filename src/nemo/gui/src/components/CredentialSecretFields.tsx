import { useRef, useState } from 'react'
import {
  Field,
  Input,
  Textarea,
  Button,
  Text,
  tokens,
} from '@fluentui/react-components'
import { Add16Regular, ArrowUpload24Regular, Dismiss16Regular } from '@fluentui/react-icons'
import type { ProviderSecretField } from '../constants/providerPresets'
import { PROVIDER_PRESETS } from '../constants/providerPresets'
import {
  GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES,
  validateGcpServiceAccountJson,
} from '../utils/gcpServiceAccountJson'

interface CredentialSecretFieldsProps {
  provider: string
  secretData: Record<string, string>
  onChange: (secretData: Record<string, string>) => void
  metadata?: Record<string, string>
  onMetadataChange?: (metadata: Record<string, string>) => void
  disabled?: boolean
}

const updateField = (
  current: Record<string, string>,
  key: string,
  value: string,
  onChange: (d: Record<string, string>) => void,
) => {
  onChange({ ...current, [key]: value })
}

function ServiceAccountJsonSecretField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ProviderSecretField
  value: string
  disabled?: boolean
  onChange: (next: string) => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [fileFeedback, setFileFeedback] = useState<{ intent: 'success' | 'error'; message: string } | null>(
    null,
  )

  const handleFile = async (file: File | undefined) => {
    setFileFeedback(null)
    if (!file) return

    if (file.size > GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES) {
      setFileFeedback({
        intent: 'error',
        message: `File is too large (${file.size.toLocaleString()} bytes). Maximum is ${GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES.toLocaleString()} bytes (${GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES / 1024} KiB).`,
      })
      return
    }

    let text: string
    try {
      text = await file.text()
    } catch {
      setFileFeedback({ intent: 'error', message: 'Could not read the file.' })
      return
    }

    const result = validateGcpServiceAccountJson(text)
    if (!result.ok) {
      setFileFeedback({ intent: 'error', message: result.message })
      return
    }

    const parsed = JSON.parse(result.normalized) as { client_email?: string }
    const pretty = JSON.stringify(parsed, null, 2)
    onChange(pretty)

    setFileFeedback({
      intent: 'success',
      message: `Loaded ${file.name} — ${typeof parsed.client_email === 'string' ? parsed.client_email : 'service account'}`,
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0]
          void handleFile(f)
          e.target.value = ''
        }}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' }}>
        <Button
          appearance="secondary"
          size="small"
          icon={<ArrowUpload24Regular />}
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
        >
          Upload JSON file
        </Button>
        <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
          Max {GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES / 1024} KiB · IAM service account key JSON only
        </Text>
      </div>
      <Textarea
        value={value}
        onChange={(_, d) => {
          setFileFeedback(null)
          onChange(d.value)
        }}
        placeholder={field.placeholder}
        disabled={disabled}
        rows={8}
        resize="vertical"
        style={{ fontFamily: 'monospace', fontSize: '13px' }}
      />
      {fileFeedback && (
        <Text
          size={200}
          style={{
            color:
              fileFeedback.intent === 'success'
                ? tokens.colorPaletteGreenForeground1
                : tokens.colorPaletteRedForeground1,
          }}
        >
          {fileFeedback.message}
        </Text>
      )}
    </div>
  )
}

export function CredentialSecretFields({
  provider,
  secretData,
  onChange,
  metadata,
  onMetadataChange,
  disabled = false,
}: CredentialSecretFieldsProps) {
  const preset = PROVIDER_PRESETS[provider]
  const hasDynamicRows = !preset

  const dynamicRows = Object.entries(secretData)
  const addDynamicSecretField = () => {
    const key = `field_${dynamicRows.length + 1}`
    onChange({ ...secretData, [key]: '' })
  }

  const renameDynamicKey = (oldKey: string, newKey: string) => {
    if (!newKey.trim() || newKey === oldKey) return
    const next = { ...secretData }
    const value = next[oldKey]
    delete next[oldKey]
    next[newKey] = value
    onChange(next)
  }

  const removeDynamicKey = (key: string) => {
    const next = { ...secretData }
    delete next[key]
    onChange(next)
  }

  return (
    <>
      {preset ? (
        <>
          {preset.secretFields.map((field) => (
            <Field key={field.key} label={field.label} required={field.required}>
              {field.jsonFileUpload ? (
                <ServiceAccountJsonSecretField
                  field={field}
                  value={secretData[field.key] || ''}
                  disabled={disabled}
                  onChange={(next) => updateField(secretData, field.key, next, onChange)}
                />
              ) : field.multiline ? (
                <Textarea
                  value={secretData[field.key] || ''}
                  onChange={(_, d) => updateField(secretData, field.key, d.value, onChange)}
                  placeholder={field.placeholder}
                  disabled={disabled}
                  rows={6}
                  resize="vertical"
                />
              ) : (
                <Input
                  type={field.type === 'password' ? 'password' : 'text'}
                  value={secretData[field.key] || ''}
                  onChange={(_, d) => updateField(secretData, field.key, d.value, onChange)}
                  placeholder={field.placeholder}
                  disabled={disabled}
                />
              )}
            </Field>
          ))}
          {preset.metadataFields && onMetadataChange && (
            <>
              <Text size={300} weight="semibold" style={{ marginTop: '8px' }}>
                Configuration
              </Text>
              {preset.metadataFields.map((field) => (
                <Field key={field.key} label={field.label} required={field.required}>
                  <Input
                    value={metadata?.[field.key] || ''}
                    onChange={(_, d) => onMetadataChange({ ...(metadata || {}), [field.key]: d.value })}
                    placeholder={field.placeholder}
                    disabled={disabled}
                  />
                </Field>
              ))}
            </>
          )}
        </>
      ) : (
        <>
          <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
            This provider has no preset secret schema. Add key/value fields manually.
          </Text>
          {dynamicRows.map(([key, value]) => (
            <div key={key} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <Input
                defaultValue={key}
                onBlur={(e) => renameDynamicKey(key, (e.target as HTMLInputElement).value)}
                placeholder="Key"
                disabled={disabled}
              />
              <Input
                type="password"
                value={value}
                onChange={(_, d) => updateField(secretData, key, d.value, onChange)}
                placeholder="Value"
                disabled={disabled}
              />
              <Button
                appearance="subtle"
                icon={<Dismiss16Regular />}
                onClick={() => removeDynamicKey(key)}
                disabled={disabled}
              />
            </div>
          ))}
          <Button
            appearance="subtle"
            icon={<Add16Regular />}
            onClick={addDynamicSecretField}
            disabled={disabled}
            style={{ alignSelf: 'flex-start' }}
          >
            Add field
          </Button>
        </>
      )}
      {!provider && (
        <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
          Select a provider to see or define secret fields.
        </Text>
      )}
      {hasDynamicRows && dynamicRows.length === 0 && (
        <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
          No secret fields added yet.
        </Text>
      )}
    </>
  )
}
