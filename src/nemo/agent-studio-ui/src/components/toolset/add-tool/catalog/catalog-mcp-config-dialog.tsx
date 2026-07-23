import { useState, type ReactElement } from "react"
import { IconTrash } from "@tabler/icons-react"

import { Card } from "@/ui-lib/base-components/card/card"
import { CardContent } from "@/ui-lib/base-components/card/card.content"
import { CardFooter } from "@/ui-lib/base-components/card/card.footer"
import { CardHeader } from "@/ui-lib/base-components/card/card.header"
import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog"
import { Button } from "@/ui-lib/base-components/button/button"
import { Input } from "@/ui-lib/base-components/input/input"
import { SelectDropdown } from "@/ui-lib/base-components/select-dropdown/select-dropdown"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { Toggle } from "@/ui-lib/base-components/toggle/toggle"
import { RadioButton, RadioGroup } from "@/ui-lib/base-components/radio-button/radio-button"
import { FormFieldErrorBlock } from "@/ui-lib/base-components/form"

import type { CatalogFormState, CatalogResourcePreset, CatalogTemplateDefinition } from "./catalog.types"
import { ADD_TOOL_STRINGS } from "../add-tool.consts"

import "./catalog.scss"

type CatalogCredentialItem = { key: string; value: string; label: string }

type CatalogMcpConfigDialogProps = {
  open: boolean
  template: CatalogTemplateDefinition
  formState: CatalogFormState
  credentialItems: CatalogCredentialItem[]
  isLoadingCredentials?: boolean
  onClose: () => void
  onEnvVarValueChange: (key: string, value: string) => void
  onRuntimeCredentialChange: (credentialId: string) => void
  onResourcePresetChange: (preset: CatalogResourcePreset) => void
  onCustomHeadersToggle: (enabled: boolean) => void
  onCustomHeaderValuesChange: (headers: Array<{ key: string; value: string }>) => void
  onRateLimitingChange: (enabled: boolean) => void
  onCallsPerMinuteChange: (value: string) => void
  onSave: () => void | Promise<boolean>
  isValidating?: boolean
  validationStatus?: "not_configured" | "successful" | "failed"
  validationMessage?: string | null
}

function CatalogMcpConfigDialog({
  open,
  template,
  formState,
  credentialItems,
  isLoadingCredentials,
  onClose,
  onEnvVarValueChange,
  onRuntimeCredentialChange,
  onResourcePresetChange,
  onCustomHeadersToggle,
  onCustomHeaderValuesChange,
  onRateLimitingChange,
  onCallsPerMinuteChange,
  onSave,
  isValidating = false,
  validationStatus = "not_configured",
  validationMessage = null,
}: CatalogMcpConfigDialogProps): ReactElement {
  const hasEnvVars = template.envVars.length > 0
  const [submitted, setSubmitted] = useState(false)
  const [blurredFields, setBlurredFields] = useState<Record<string, boolean>>({})

  const requiredEnvVars = template.envVars.filter((v) => v.isRequired)
  const missingRequiredFields = requiredEnvVars.filter(
    (v) => !(formState.envVarValues[v.key] ?? v.value).trim(),
  )
  const isRuntimeCredentialRequired = !!template.runtimeCredential?.isRequired
  const missingRuntimeCredential =
    isRuntimeCredentialRequired && !formState.runtimeCredentialId
  const hasValidationErrors = missingRequiredFields.length > 0 || missingRuntimeCredential

  const handleSave = async (): Promise<void> => {
    setSubmitted(true)
    if (hasValidationErrors) return
    const saved = await onSave()
    if (saved !== false) {
      setSubmitted(false)
      setBlurredFields({})
    }
  }

  const handleClose = (): void => {
    setSubmitted(false)
    setBlurredFields({})
    onClose()
  }

  const handleBlur = (key: string): void => {
    setBlurredFields((prev) => ({ ...prev, [key]: true }))
  }

  const getFieldError = (envVarKey: string, isRequired: boolean, value: string): string | undefined => {
    if (!isRequired) return undefined
    if (!value.trim()) return `${envVarKey} is required`
    return undefined
  }

  const updateHeaderList = (
    list: Array<{ key: string; value: string }>,
    index: number,
    field: "key" | "value",
    value: string,
  ): void => {
    const next = [...list]
    next[index] = { ...next[index], [field]: value }
    onCustomHeaderValuesChange(next)
  }

  const removeHeaderRow = (list: Array<{ key: string; value: string }>, index: number): void => {
    const next = list.filter((_, i) => i !== index)
    onCustomHeaderValuesChange(next.length > 0 ? next : [{ key: "", value: "" }])
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) handleClose() }} size="lg" isDismissOnOutsideClick>
      <DialogPopup showCloseButton={false}>
        <Card className="mcp-config-dialog-card">
          <CardHeader title={ADD_TOOL_STRINGS.MCP_SECTION_TITLE} hasSeparator />
          <CardContent>
            <div className="catalog-config__dialog-content">

              {template.runtimeCredential && (
                <>
                  <div className="catalog-config__separator" />
                  <div>
                    <div className="catalog-config__credential-header">
                      <Typography fontSize="fs14" boldness="regular">
                        Runtime Credential
                      </Typography>
                      <span className="catalog-config__credential-badge">
                        {template.runtimeCredential.type}
                      </span>
                      {template.runtimeCredential.isRequired && (
                        <span style={{ color: "var(--notification-error)" }}>*</span>
                      )}
                    </div>
                    <SelectDropdown
                      items={credentialItems}
                      value={formState.runtimeCredentialId || null}
                      onValueChange={(value) =>
                        onRuntimeCredentialChange(typeof value === "string" ? value : "")
                      }
                      isLoading={isLoadingCredentials}
                      disabled={!isLoadingCredentials && credentialItems.length === 0}
                      placeholder={
                        credentialItems.length > 0
                          ? `Select a '${template.runtimeCredential.type}' credential`
                          : `No '${template.runtimeCredential.type}' credentials in this project yet`
                      }
                      emptyMessage={`No '${template.runtimeCredential.type}' credentials in this project yet`}
                      error={
                        submitted && missingRuntimeCredential
                          ? `A '${template.runtimeCredential.type}' credential is required`
                          : undefined
                      }
                      options={{ isSearchable: credentialItems.length > 5 }}
                    />
                    <Typography
                      Component="p"
                      fontSize="fs12"
                      color="var(--text-secondary)"
                      className="catalog-config__helper-text"
                    >
                      {template.runtimeCredential.helperText}
                    </Typography>
                  </div>
                </>
              )}

              {hasEnvVars && (
                <>
                  <div className="catalog-config__separator" />
                  <Typography Component="p" fontSize="fs14" boldness="semibold">
                    {ADD_TOOL_STRINGS.CATALOG_ENV_VARS_LABEL}
                  </Typography>
                  <div className="catalog-config__form">
                    {template.envVars.map((envVar) => {
                      const currentValue = formState.envVarValues[envVar.key] ?? envVar.value
                      const fieldError = getFieldError(envVar.key, !!envVar.isRequired, currentValue)
                      const showError = fieldError && (blurredFields[envVar.key] || submitted)
                      return (
                        <div key={envVar.key}>
                          <Input
                            label={envVar.isRequired ? `${envVar.key} *` : envVar.key}
                            placeholder={envVar.placeholder ?? envVar.value}
                            value={currentValue}
                            onChange={(e) => onEnvVarValueChange(envVar.key, e.target.value)}
                            onBlur={() => handleBlur(envVar.key)}
                            isError={!!showError}
                          />
                          {showError ? (
                            <FormFieldErrorBlock message={fieldError} />
                          ) : (
                            <Typography
                              Component="p"
                              fontSize="fs12"
                              color="var(--text-secondary)"
                              className="catalog-config__helper-text"
                            >
                              {envVar.helperText}
                            </Typography>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </>
              )}

              {template.hasResourcePreset && template.resourcePresetOptions && (
                <>
                  <div className="catalog-config__separator" />
                  <Typography Component="p" fontSize="fs14" boldness="semibold">
                    {ADD_TOOL_STRINGS.CATALOG_RESOURCE_PRESET_LABEL}
                  </Typography>
                  <RadioGroup
                    value={formState.resourcePreset}
                    onValueChange={(val) => {
                      if (typeof val === "string") onResourcePresetChange(val as CatalogResourcePreset)
                    }}
                    ariaLabel={ADD_TOOL_STRINGS.CATALOG_RESOURCE_PRESET_LABEL}
                  >
                    <div className="catalog-config__preset-row">
                      {template.resourcePresetOptions.map((option) => (
                        <label
                          key={option.value}
                          className="catalog-config__preset-label"
                        >
                          <RadioButton value={option.value} />
                          <span>{option.label}</span>
                        </label>
                      ))}
                    </div>
                  </RadioGroup>
                </>
              )}

              <div className="catalog-config__separator" />
              <div className="mcp-config-dialog__toggle-row">
                <Toggle checked={formState.addCustomHeaders} onCheckedChange={onCustomHeadersToggle} ariaLabel={ADD_TOOL_STRINGS.ADD_CUSTOM_HEADERS_TOGGLE} />
                <span className="mcp-config-dialog__toggle-label">{ADD_TOOL_STRINGS.ADD_CUSTOM_HEADERS_TOGGLE}</span>
              </div>
              {formState.addCustomHeaders && (
                <div className="mcp-config-dialog__headers-list">
                  {formState.customHeaders.map((header, index) => (
                    <div key={`h-${index}`} className="mcp-config-dialog__header-row">
                      <Input label={ADD_TOOL_STRINGS.HEADER_KEY_LABEL} value={header.key} onChange={(e) => updateHeaderList(formState.customHeaders, index, "key", e.target.value)} />
                      <Input label={ADD_TOOL_STRINGS.HEADER_VALUE_LABEL} value={header.value} onChange={(e) => updateHeaderList(formState.customHeaders, index, "value", e.target.value)} />
                      <Button className="mcp-config-dialog__header-row-action" variant="icon" icon={<IconTrash size={16} />} aria-label="Delete header" onClick={() => removeHeaderRow(formState.customHeaders, index)} />
                    </div>
                  ))}
                  <Button variant="outline" size="small" label={ADD_TOOL_STRINGS.ADD_CUSTOM_HEADER_ACTION} onClick={() => onCustomHeaderValuesChange([...formState.customHeaders, { key: "", value: "" }])} />
                </div>
              )}

              <div className="mcp-config-dialog__toggle-row">
                <Toggle checked={formState.applyRateLimiting} onCheckedChange={onRateLimitingChange} ariaLabel={ADD_TOOL_STRINGS.APPLY_RATE_LIMITING_TOGGLE} />
                <span className="mcp-config-dialog__toggle-label">{ADD_TOOL_STRINGS.APPLY_RATE_LIMITING_TOGGLE}</span>
              </div>
              {formState.applyRateLimiting && (
                <Input label={ADD_TOOL_STRINGS.CALLS_PER_MINUTE_LABEL} value={formState.callsPerMinute} onChange={(e) => onCallsPerMinuteChange(e.target.value)} />
              )}
            </div>
          </CardContent>
          <CardFooter
            hasSeparator
            alignment="end"
            actions={[
              { variant: "outline", label: ADD_TOOL_STRINGS.DISCARD_ACTION_LABEL, onClick: handleClose },
              { variant: "solid", label: isValidating ? "Validating..." : ADD_TOOL_STRINGS.SAVE_MCP_ACTION_LABEL, onClick: handleSave, isDisabled: isValidating },
            ]}
          />
          {validationStatus === "failed" && validationMessage && (
            <CardContent>
              <FormFieldErrorBlock message={validationMessage} />
            </CardContent>
          )}
        </Card>
      </DialogPopup>
    </Dialog>
  )
}

export { CatalogMcpConfigDialog }
export type { CatalogMcpConfigDialogProps }
