import { useState, type ReactElement } from "react"
import { IconTrash } from "@tabler/icons-react"

import { Button } from "@/ui-lib/base-components/button/button"
import { Card } from "@/ui-lib/base-components/card/card"
import { CardContent } from "@/ui-lib/base-components/card/card.content"
import { CardFooter } from "@/ui-lib/base-components/card/card.footer"
import { CardHeader } from "@/ui-lib/base-components/card/card.header"
import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog"
import { Input } from "@/ui-lib/base-components/input/input"
import { Toggle } from "@/ui-lib/base-components/toggle/toggle"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { FormFieldErrorBlock } from "@/ui-lib/base-components/form"

import type { ToolsetConfigField } from "./edit-tool.types"
import { ADD_TOOL_STRINGS } from "../add-tool/add-tool.consts"

import "./edit-config-dialog.scss"

type EditConfigDialogProps = {
  open: boolean
  title?: string
  fields: ToolsetConfigField[]
  onFieldChange: (key: string, value: string) => void
  addCustomHeaders: boolean
  customHeaders: Array<{ key: string; value: string }>
  onCustomHeadersToggle: (enabled: boolean) => void
  onCustomHeaderValuesChange: (headers: Array<{ key: string; value: string }>) => void
  addForwardedHeaders: boolean
  forwardedHeaders: string[]
  onForwardedHeadersToggle: (enabled: boolean) => void
  onForwardedHeaderValuesChange: (headers: string[]) => void
  /** Platform MCPs ship default forward headers; show them read-only. */
  forwardHeadersReadOnly?: boolean
  applyRateLimiting: boolean
  callsPerMinute: string
  onRateLimitingToggle: (enabled: boolean) => void
  onCallsPerMinuteChange: (value: string) => void
  onSave: () => void
  onClose: () => void
}

function EditConfigDialog({
  open,
  title = "MCP server configuration",
  fields,
  onFieldChange,
  addCustomHeaders,
  customHeaders,
  onCustomHeadersToggle,
  onCustomHeaderValuesChange,
  addForwardedHeaders,
  forwardedHeaders,
  onForwardedHeadersToggle,
  onForwardedHeaderValuesChange,
  forwardHeadersReadOnly = false,
  applyRateLimiting,
  callsPerMinute,
  onRateLimitingToggle,
  onCallsPerMinuteChange,
  onSave,
  onClose,
}: EditConfigDialogProps): ReactElement {
  const [submitted, setSubmitted] = useState(false)
  const [blurredFields, setBlurredFields] = useState<Record<string, boolean>>({})

  const requiredFields = fields.filter((f) => f.isRequired)
  const missingRequired = requiredFields.filter((f) => !f.value.trim())
  const hasErrors = missingRequired.length > 0

  const handleSave = (): void => {
    setSubmitted(true)
    if (hasErrors) return
    setSubmitted(false)
    setBlurredFields({})
    onSave()
  }

  const handleClose = (): void => {
    setSubmitted(false)
    setBlurredFields({})
    onClose()
  }

  const handleBlur = (key: string): void => {
    setBlurredFields((prev) => ({ ...prev, [key]: true }))
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

  const updateForwardedHeader = (list: string[], index: number, value: string): void => {
    const next = [...list]
    next[index] = value
    onForwardedHeaderValuesChange(next)
  }

  const removeForwardedHeaderRow = (list: string[], index: number): void => {
    const next = list.filter((_, i) => i !== index)
    onForwardedHeaderValuesChange(next.length > 0 ? next : [""])
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) handleClose() }} size="lg" isDismissOnOutsideClick>
      <DialogPopup showCloseButton={false}>
        <Card className="mcp-config-dialog-card">
          <CardHeader title={title} hasSeparator />
          <CardContent>
            <div className="mcp-config-dialog__content">
              {fields.map((field) => {
                const fieldError = field.isRequired && !field.value.trim() ? `${field.label} is required` : undefined
                const showError = fieldError && (blurredFields[field.key] || submitted)
                return (
                  <div key={field.key}>
                    <Input
                      label={field.isRequired ? `${field.label} *` : field.label}
                      value={field.value}
                      onChange={(e) => onFieldChange(field.key, e.target.value)}
                      onBlur={() => handleBlur(field.key)}
                      isError={!!showError}
                    />
                    {showError ? (
                      <FormFieldErrorBlock message={fieldError} />
                    ) : field.helperText ? (
                      <Typography
                        Component="p"
                        fontSize="fs12"
                        color="var(--text-secondary)"
                        style={{ marginTop: "4px" }}
                      >
                        {field.helperText}
                      </Typography>
                    ) : null}
                  </div>
                )
              })}

              <div className="mcp-config-dialog__toggle-row">
                <Toggle checked={addCustomHeaders} onCheckedChange={onCustomHeadersToggle} ariaLabel={ADD_TOOL_STRINGS.ADD_CUSTOM_HEADERS_TOGGLE} />
                <span className="mcp-config-dialog__toggle-label">{ADD_TOOL_STRINGS.ADD_CUSTOM_HEADERS_TOGGLE}</span>
              </div>
              {addCustomHeaders && (
                <div className="mcp-config-dialog__headers-list">
                  {customHeaders.map((header, index) => (
                    <div key={`h-${index}`} className="mcp-config-dialog__header-row">
                      <Input label={ADD_TOOL_STRINGS.HEADER_KEY_LABEL} value={header.key} onChange={(e) => updateHeaderList(customHeaders, index, "key", e.target.value)} />
                      <Input label={ADD_TOOL_STRINGS.HEADER_VALUE_LABEL} value={header.value} onChange={(e) => updateHeaderList(customHeaders, index, "value", e.target.value)} />
                      <Button className="mcp-config-dialog__header-row-action" variant="icon" icon={<IconTrash size={16} />} aria-label="Delete header" onClick={() => removeHeaderRow(customHeaders, index)} />
                    </div>
                  ))}
                  <Button variant="outline" size="small" label={ADD_TOOL_STRINGS.ADD_CUSTOM_HEADER_ACTION} onClick={() => onCustomHeaderValuesChange([...customHeaders, { key: "", value: "" }])} />
                </div>
              )}

              <div className="mcp-config-dialog__toggle-row">
                <Toggle
                  checked={addForwardedHeaders}
                  onCheckedChange={onForwardedHeadersToggle}
                  ariaLabel={ADD_TOOL_STRINGS.FORWARD_HEADERS_TOGGLE}
                  isDisabled={forwardHeadersReadOnly}
                />
                <span className="mcp-config-dialog__toggle-label">{ADD_TOOL_STRINGS.FORWARD_HEADERS_TOGGLE}</span>
              </div>
              {addForwardedHeaders && (
                <div className="mcp-config-dialog__headers-list">
                  <Typography Component="p" fontSize="fs12" color="var(--text-secondary)">
                    {forwardHeadersReadOnly
                      ? "These headers are forwarded automatically for platform-managed MCP servers."
                      : ADD_TOOL_STRINGS.FORWARD_HEADERS_HINT}
                  </Typography>
                  {forwardedHeaders.map((header, index) => (
                    <div key={`fh-${index}`} className="mcp-config-dialog__header-row">
                      <Input
                        label={ADD_TOOL_STRINGS.FORWARD_HEADER_NAME_LABEL}
                        placeholder="X-Project-ID"
                        value={header}
                        onChange={(e) => updateForwardedHeader(forwardedHeaders, index, e.target.value)}
                        isDisabled={forwardHeadersReadOnly}
                      />
                      {!forwardHeadersReadOnly && (
                        <Button className="mcp-config-dialog__header-row-action" variant="icon" icon={<IconTrash size={16} />} aria-label="Delete forwarded header" onClick={() => removeForwardedHeaderRow(forwardedHeaders, index)} />
                      )}
                    </div>
                  ))}
                  {!forwardHeadersReadOnly && (
                    <Button variant="outline" size="small" label={ADD_TOOL_STRINGS.ADD_FORWARD_HEADER_ACTION} onClick={() => onForwardedHeaderValuesChange([...forwardedHeaders, ""])} />
                  )}
                </div>
              )}

              <div className="mcp-config-dialog__toggle-row">
                <Toggle checked={applyRateLimiting} onCheckedChange={onRateLimitingToggle} ariaLabel={ADD_TOOL_STRINGS.APPLY_RATE_LIMITING_TOGGLE} />
                <span className="mcp-config-dialog__toggle-label">{ADD_TOOL_STRINGS.APPLY_RATE_LIMITING_TOGGLE}</span>
              </div>
              {applyRateLimiting && (
                <Input label={ADD_TOOL_STRINGS.CALLS_PER_MINUTE_LABEL} value={callsPerMinute} onChange={(e) => onCallsPerMinuteChange(e.target.value)} />
              )}
            </div>
          </CardContent>
          <CardFooter
            hasSeparator
            alignment="end"
            actions={[
              { variant: "outline", label: "Cancel", onClick: handleClose },
              { variant: "solid", label: "Save", onClick: handleSave },
            ]}
          />
        </Card>
      </DialogPopup>
    </Dialog>
  )
}

export { EditConfigDialog }
export type { EditConfigDialogProps }
