import { useState, type ReactElement } from "react"
import { IconAlertTriangle, IconTrash } from "@tabler/icons-react"
import "./custom-mcp-config-dialog.scss"

import { Button } from "@/ui-lib/base-components/button/button"
import { Card } from "@/ui-lib/base-components/card/card"
import { CardContent } from "@/ui-lib/base-components/card/card.content"
import { CardFooter } from "@/ui-lib/base-components/card/card.footer"
import { CardHeader } from "@/ui-lib/base-components/card/card.header"
import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog"
import { Input } from "@/ui-lib/base-components/input/input"
import { SelectDropdown } from "@/ui-lib/base-components/select-dropdown/select-dropdown"
import { Toggle } from "@/ui-lib/base-components/toggle/toggle"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { FormFieldErrorBlock } from "@/ui-lib/base-components/form"

import {
  ADD_TOOL_EMPTY_MCP_HEADER,
  ADD_TOOL_MCP_AUTH_TYPE_OPTIONS,
  ADD_TOOL_MCP_CONNECTION_TYPE_OPTIONS,
  ADD_TOOL_STRINGS,
} from "../add-tool.consts"
import type { AddToolMcpConfig } from "../add-tool.types"

type AddToolMcpConfigDialogProps = {
  open: boolean
  mcpConfigDraft: AddToolMcpConfig
  onClose: () => void
  onDraftChange: (value: Partial<AddToolMcpConfig>) => void
  onCustomHeadersChange: (value: Array<{ key: string; value: string }>) => void
  onForwardedHeadersChange: (value: string[]) => void
  onSave: () => void | Promise<boolean>
  isValidating?: boolean
  validationStatus?: "not_configured" | "successful" | "failed"
  validationMessage?: string | null
}

function AddToolMcpConfigDialog({
  open,
  mcpConfigDraft,
  onClose,
  onDraftChange,
  onCustomHeadersChange,
  onForwardedHeadersChange,
  onSave,
  isValidating = false,
  validationStatus = "not_configured",
  validationMessage = null,
}: AddToolMcpConfigDialogProps): ReactElement {
  const [submitted, setSubmitted] = useState(false)
  const [blurredFields, setBlurredFields] = useState<Record<string, boolean>>({})

  const serverUrlError = !mcpConfigDraft.serverUrl.trim() ? "Server URL is required" : undefined

  const getAuthFieldErrors = (): Record<string, string> => {
    const errors: Record<string, string> = {}
    const { authType } = mcpConfigDraft

    if (authType === "enterprise_jwt_oidc") {
      if (!mcpConfigDraft.issuerUrl.trim()) errors.issuerUrl = "Issuer URL is required"
      if (!mcpConfigDraft.clientId.trim()) errors.clientId = "Client ID is required"
      if (!mcpConfigDraft.scope.trim()) errors.scope = "Scope is required"
    } else if (authType === "oauth2_pkce") {
      if (!mcpConfigDraft.authorizationEndpointUrl.trim()) errors.authorizationEndpointUrl = "Authorization endpoint URL is required"
      if (!mcpConfigDraft.tokenEndpointUrl.trim()) errors.tokenEndpointUrl = "Token endpoint URL is required"
      if (!mcpConfigDraft.clientId.trim()) errors.clientId = "Client ID is required"
    } else if (authType === "oauth2_client_credentials") {
      if (!mcpConfigDraft.tokenEndpointUrl.trim()) errors.tokenEndpointUrl = "Token endpoint URL is required"
      if (!mcpConfigDraft.clientId.trim()) errors.clientId = "Client ID is required"
      if (!mcpConfigDraft.clientSecret.trim()) errors.clientSecret = "Client Secret is required"
    } else if (authType === "api_key") {
      if (!mcpConfigDraft.apiKey.trim()) errors.apiKey = "API key is required"
    } else if (authType === "bearer_token") {
      if (!mcpConfigDraft.bearerToken.trim()) errors.bearerToken = "Bearer token is required"
    }

    return errors
  }

  const authErrors = getAuthFieldErrors()
  const hasErrors = !!serverUrlError || Object.keys(authErrors).length > 0

  const showFieldError = (fieldKey: string, error: string | undefined): boolean => {
    return !!error && (!!blurredFields[fieldKey] || submitted)
  }

  const handleBlur = (fieldKey: string): void => {
    setBlurredFields((prev) => ({ ...prev, [fieldKey]: true }))
  }

  const handleSave = async (): Promise<void> => {
    setSubmitted(true)
    if (hasErrors) return
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

  const updateHeaderList = (
    list: Array<{ key: string; value: string }>,
    index: number,
    key: "key" | "value",
    value: string,
  ): void => {
    const next = [...list]
    next[index] = { ...next[index], [key]: value }
    onCustomHeadersChange(next)
  }

  const removeHeaderRow = (list: Array<{ key: string; value: string }>, index: number): void => {
    const next = list.filter((_, i) => i !== index)
    onCustomHeadersChange(next.length > 0 ? next : [{ ...ADD_TOOL_EMPTY_MCP_HEADER }])
  }

  const updateForwardedHeader = (list: string[], index: number, value: string): void => {
    const next = [...list]
    next[index] = value
    onForwardedHeadersChange(next)
  }

  const removeForwardedHeaderRow = (list: string[], index: number): void => {
    const next = list.filter((_, i) => i !== index)
    onForwardedHeadersChange(next.length > 0 ? next : [""])
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) handleClose() }} size="lg" isDismissOnOutsideClick>
      <DialogPopup showCloseButton={false}>
        <Card className="mcp-config-dialog-card">
          <CardHeader title={ADD_TOOL_STRINGS.CONFIGURE_DIALOG_TITLE} hasSeparator />
          <CardContent>
            <div className="mcp-config-dialog__content">
              <Typography Component="h4" fontSize="fs14" boldness="semibold">
                {ADD_TOOL_STRINGS.MCP_SERVER_DETAILS_TITLE}
              </Typography>
              <div>
                <Input label={ADD_TOOL_STRINGS.SERVER_URL_LABEL} placeholder={ADD_TOOL_STRINGS.SERVER_URL_PLACEHOLDER} value={mcpConfigDraft.serverUrl} onChange={(e) => onDraftChange({ serverUrl: e.target.value })} onBlur={() => handleBlur("serverUrl")} isError={showFieldError("serverUrl", serverUrlError)} />
                {showFieldError("serverUrl", serverUrlError) && <FormFieldErrorBlock message={serverUrlError!} />}
              </div>
              <SelectDropdown label={ADD_TOOL_STRINGS.CONNECTION_TYPE_LABEL} items={ADD_TOOL_MCP_CONNECTION_TYPE_OPTIONS} value={mcpConfigDraft.connectionType} onValueChange={(value) => { if (value === "sse" || value === "streamable_http") onDraftChange({ connectionType: value }) }} />

              <Typography Component="h4" fontSize="fs14" boldness="semibold">
                {ADD_TOOL_STRINGS.AUTHENTICATION_DETAILS_TITLE}
              </Typography>
              <SelectDropdown label={ADD_TOOL_STRINGS.AUTHENTICATION_TYPE_LABEL} items={ADD_TOOL_MCP_AUTH_TYPE_OPTIONS} value={mcpConfigDraft.authType} onValueChange={(value) => { if (typeof value === "string") onDraftChange({ authType: value as AddToolMcpConfig["authType"] }) }} />

              {mcpConfigDraft.authType === "enterprise_jwt_oidc" && (
                <>
                  <div>
                    <Input label={`${ADD_TOOL_STRINGS.ISSUER_URL_LABEL} *`} placeholder="https://login.microsoftonline.com/" value={mcpConfigDraft.issuerUrl} onChange={(e) => onDraftChange({ issuerUrl: e.target.value })} onBlur={() => handleBlur("issuerUrl")} isError={showFieldError("issuerUrl", authErrors.issuerUrl)} />
                    {showFieldError("issuerUrl", authErrors.issuerUrl) && <FormFieldErrorBlock message={authErrors.issuerUrl!} />}
                  </div>
                  <div>
                    <Input label={`${ADD_TOOL_STRINGS.CLIENT_ID_LABEL} *`} placeholder="Enter Client ID" value={mcpConfigDraft.clientId} onChange={(e) => onDraftChange({ clientId: e.target.value })} onBlur={() => handleBlur("clientId")} isError={showFieldError("clientId", authErrors.clientId)} />
                    {showFieldError("clientId", authErrors.clientId) && <FormFieldErrorBlock message={authErrors.clientId!} />}
                  </div>
                  <div>
                    <Input label={`${ADD_TOOL_STRINGS.SCOPE_LABEL} *`} placeholder="Comma-separated list of applied scopes" value={mcpConfigDraft.scope} onChange={(e) => onDraftChange({ scope: e.target.value })} onBlur={() => handleBlur("scope")} isError={showFieldError("scope", authErrors.scope)} />
                    {showFieldError("scope", authErrors.scope) && <FormFieldErrorBlock message={authErrors.scope!} />}
                  </div>
                  <Input label={ADD_TOOL_STRINGS.JWKS_URL_LABEL} isOptional placeholder="https://auth.example.com/.well-known/jwks.json" value={mcpConfigDraft.jwksUrl} onChange={(e) => onDraftChange({ jwksUrl: e.target.value })} />
                </>
              )}

              {mcpConfigDraft.authType === "oauth2_pkce" && (
                <>
                  <div>
                    <Input label={`${ADD_TOOL_STRINGS.AUTHORIZATION_ENDPOINT_URL_LABEL} *`} placeholder="https://auth.example.com/oauth/token" value={mcpConfigDraft.authorizationEndpointUrl} onChange={(e) => onDraftChange({ authorizationEndpointUrl: e.target.value })} onBlur={() => handleBlur("authorizationEndpointUrl")} isError={showFieldError("authorizationEndpointUrl", authErrors.authorizationEndpointUrl)} />
                    {showFieldError("authorizationEndpointUrl", authErrors.authorizationEndpointUrl) && <FormFieldErrorBlock message={authErrors.authorizationEndpointUrl!} />}
                  </div>
                  <div>
                    <Input label={`${ADD_TOOL_STRINGS.TOKEN_ENDPOINT_URL_LABEL} *`} placeholder="https://auth.example.com/oauth/token" value={mcpConfigDraft.tokenEndpointUrl} onChange={(e) => onDraftChange({ tokenEndpointUrl: e.target.value })} onBlur={() => handleBlur("tokenEndpointUrl")} isError={showFieldError("tokenEndpointUrl", authErrors.tokenEndpointUrl)} />
                    {showFieldError("tokenEndpointUrl", authErrors.tokenEndpointUrl) && <FormFieldErrorBlock message={authErrors.tokenEndpointUrl!} />}
                  </div>
                  <div>
                    <Input label={`${ADD_TOOL_STRINGS.CLIENT_ID_LABEL} *`} placeholder="Enter Client ID" value={mcpConfigDraft.clientId} onChange={(e) => onDraftChange({ clientId: e.target.value })} onBlur={() => handleBlur("clientId")} isError={showFieldError("clientId", authErrors.clientId)} />
                    {showFieldError("clientId", authErrors.clientId) && <FormFieldErrorBlock message={authErrors.clientId!} />}
                  </div>
                  <Input label={ADD_TOOL_STRINGS.SCOPE_LABEL} isOptional placeholder="Comma-separated list of applied scopes" value={mcpConfigDraft.scope} onChange={(e) => onDraftChange({ scope: e.target.value })} />
                </>
              )}

              {mcpConfigDraft.authType === "oauth2_client_credentials" && (
                <>
                  <div>
                    <Input label={`${ADD_TOOL_STRINGS.TOKEN_ENDPOINT_URL_LABEL} *`} placeholder="https://auth.example.com/oauth/token" value={mcpConfigDraft.tokenEndpointUrl} onChange={(e) => onDraftChange({ tokenEndpointUrl: e.target.value })} onBlur={() => handleBlur("tokenEndpointUrl")} isError={showFieldError("tokenEndpointUrl", authErrors.tokenEndpointUrl)} />
                    {showFieldError("tokenEndpointUrl", authErrors.tokenEndpointUrl) && <FormFieldErrorBlock message={authErrors.tokenEndpointUrl!} />}
                  </div>
                  <div>
                    <Input label={`${ADD_TOOL_STRINGS.CLIENT_ID_LABEL} *`} placeholder="Enter Client ID" value={mcpConfigDraft.clientId} onChange={(e) => onDraftChange({ clientId: e.target.value })} onBlur={() => handleBlur("clientId")} isError={showFieldError("clientId", authErrors.clientId)} />
                    {showFieldError("clientId", authErrors.clientId) && <FormFieldErrorBlock message={authErrors.clientId!} />}
                  </div>
                  <div>
                    <Input label={`${ADD_TOOL_STRINGS.CLIENT_SECRET_LABEL} *`} placeholder="Enter Client Secret" value={mcpConfigDraft.clientSecret} onChange={(e) => onDraftChange({ clientSecret: e.target.value })} onBlur={() => handleBlur("clientSecret")} isError={showFieldError("clientSecret", authErrors.clientSecret)} />
                    {showFieldError("clientSecret", authErrors.clientSecret) && <FormFieldErrorBlock message={authErrors.clientSecret!} />}
                  </div>
                </>
              )}

              {mcpConfigDraft.authType === "api_key" && (
                <>
                  <div>
                    <Input label={`${ADD_TOOL_STRINGS.API_KEY_LABEL} *`} placeholder="Enter API key" value={mcpConfigDraft.apiKey} onChange={(e) => onDraftChange({ apiKey: e.target.value })} onBlur={() => handleBlur("apiKey")} isError={showFieldError("apiKey", authErrors.apiKey)} />
                    {showFieldError("apiKey", authErrors.apiKey) && <FormFieldErrorBlock message={authErrors.apiKey!} />}
                  </div>
                  <Input label={ADD_TOOL_STRINGS.HEADER_NAME_LABEL} placeholder="X-API-Key" value={mcpConfigDraft.headerName} onChange={(e) => onDraftChange({ headerName: e.target.value })} />
                </>
              )}

              {mcpConfigDraft.authType === "bearer_token" && (
                <div>
                  <Input label={`${ADD_TOOL_STRINGS.BEARER_TOKEN_LABEL} *`} placeholder="Enter Bearer token" value={mcpConfigDraft.bearerToken} onChange={(e) => onDraftChange({ bearerToken: e.target.value })} onBlur={() => handleBlur("bearerToken")} isError={showFieldError("bearerToken", authErrors.bearerToken)} />
                  {showFieldError("bearerToken", authErrors.bearerToken) && <FormFieldErrorBlock message={authErrors.bearerToken!} />}
                </div>
              )}

              {mcpConfigDraft.authType === "no_auth" && (
                <div className="mcp-config-dialog__warning">
                  <IconAlertTriangle size={14} />
                  <span>{ADD_TOOL_STRINGS.MCP_UNAUTH_WARNING}</span>
                </div>
              )}

              <div className="mcp-config-dialog__toggle-row">
                <Toggle checked={mcpConfigDraft.addCustomHeaders} onCheckedChange={(checked) => onDraftChange({ addCustomHeaders: checked })} ariaLabel={ADD_TOOL_STRINGS.ADD_CUSTOM_HEADERS_TOGGLE} />
                <span className="mcp-config-dialog__toggle-label">{ADD_TOOL_STRINGS.ADD_CUSTOM_HEADERS_TOGGLE}</span>
              </div>
              {mcpConfigDraft.addCustomHeaders && (
                <div className="mcp-config-dialog__headers-list">
                  {mcpConfigDraft.customHeaders.map((header, index) => (
                    <div key={`h-${index}`} className="mcp-config-dialog__header-row">
                      <Input label={ADD_TOOL_STRINGS.HEADER_KEY_LABEL} value={header.key} onChange={(e) => updateHeaderList(mcpConfigDraft.customHeaders, index, "key", e.target.value)} />
                      <Input label={ADD_TOOL_STRINGS.HEADER_VALUE_LABEL} value={header.value} onChange={(e) => updateHeaderList(mcpConfigDraft.customHeaders, index, "value", e.target.value)} />
                      <Button className="mcp-config-dialog__header-row-action" variant="icon" icon={<IconTrash size={16} />} aria-label="Delete header" onClick={() => removeHeaderRow(mcpConfigDraft.customHeaders, index)} />
                    </div>
                  ))}
                  <Button variant="outline" size="small" label={ADD_TOOL_STRINGS.ADD_CUSTOM_HEADER_ACTION} onClick={() => onCustomHeadersChange([...mcpConfigDraft.customHeaders, { ...ADD_TOOL_EMPTY_MCP_HEADER }])} />
                </div>
              )}

              <div className="mcp-config-dialog__toggle-row">
                <Toggle checked={mcpConfigDraft.addForwardedHeaders} onCheckedChange={(checked) => onDraftChange({ addForwardedHeaders: checked })} ariaLabel={ADD_TOOL_STRINGS.FORWARD_HEADERS_TOGGLE} />
                <span className="mcp-config-dialog__toggle-label">{ADD_TOOL_STRINGS.FORWARD_HEADERS_TOGGLE}</span>
              </div>
              {mcpConfigDraft.addForwardedHeaders && (
                <div className="mcp-config-dialog__headers-list">
                  <Typography Component="p" fontSize="fs12" color="var(--text-secondary)">
                    {ADD_TOOL_STRINGS.FORWARD_HEADERS_HINT}
                  </Typography>
                  {mcpConfigDraft.forwardedHeaders.map((header, index) => (
                    <div key={`fh-${index}`} className="mcp-config-dialog__header-row">
                      <Input label={ADD_TOOL_STRINGS.FORWARD_HEADER_NAME_LABEL} placeholder="X-Project-ID" value={header} onChange={(e) => updateForwardedHeader(mcpConfigDraft.forwardedHeaders, index, e.target.value)} />
                      <Button className="mcp-config-dialog__header-row-action" variant="icon" icon={<IconTrash size={16} />} aria-label="Delete forwarded header" onClick={() => removeForwardedHeaderRow(mcpConfigDraft.forwardedHeaders, index)} />
                    </div>
                  ))}
                  <Button variant="outline" size="small" label={ADD_TOOL_STRINGS.ADD_FORWARD_HEADER_ACTION} onClick={() => onForwardedHeadersChange([...mcpConfigDraft.forwardedHeaders, ""])} />
                </div>
              )}

              <div className="mcp-config-dialog__toggle-row">
                <Toggle checked={mcpConfigDraft.applyRateLimiting} onCheckedChange={(checked) => onDraftChange({ applyRateLimiting: checked })} ariaLabel={ADD_TOOL_STRINGS.APPLY_RATE_LIMITING_TOGGLE} />
                <span className="mcp-config-dialog__toggle-label">{ADD_TOOL_STRINGS.APPLY_RATE_LIMITING_TOGGLE}</span>
              </div>
              {mcpConfigDraft.applyRateLimiting && (
                <Input label={ADD_TOOL_STRINGS.CALLS_PER_MINUTE_LABEL} value={mcpConfigDraft.callsPerMinute} onChange={(e) => onDraftChange({ callsPerMinute: e.target.value })} />
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

export { AddToolMcpConfigDialog as CustomMcpConfigDialog }
export type { AddToolMcpConfigDialogProps as CustomMcpConfigDialogProps }
