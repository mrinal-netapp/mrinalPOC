import { type ReactElement } from "react"

import { Card } from "@/ui-lib/base-components/card/card"
import { CardHeader } from "@/ui-lib/base-components/card/card.header"
import { CardContent } from "@/ui-lib/base-components/card/card.content"
import { useListCredentialsQuery } from "@/routes/pages/credentials/credential-api.slice"

import { ToolsetMcpCard } from "../../toolset-mcp-card/toolset-mcp-card"
import type { McpConnectionStatus, McpDetailRow } from "../../toolset-mcp-card/toolset-mcp-card"
import type { CatalogFormState, CatalogTemplateDefinition } from "./catalog.types"
import { ADD_TOOL_STRINGS } from "../add-tool.consts"

import "./catalog.scss"

type CatalogMcpConfigCardProps = {
  projectId: string | undefined
  template: CatalogTemplateDefinition
  formState: CatalogFormState
  onConfigure: () => void
}

function buildSavedDetails(
  template: CatalogTemplateDefinition,
  formState: CatalogFormState,
  runtimeCredentialName: string | undefined,
): McpDetailRow[] {
  const rows: McpDetailRow[] = []

  if (template.runtimeCredential) {
    rows.push({
      label: "Runtime Credential",
      value:
        runtimeCredentialName
        ?? (formState.runtimeCredentialId || template.runtimeCredential.type),
    })
  }

  for (const envVar of template.envVars) {
    const val = formState.envVarValues[envVar.key] ?? envVar.value
    if (val) rows.push({ label: envVar.key, value: val })
  }

  if (template.hasResourcePreset) {
    const preset = template.resourcePresetOptions?.find((o) => o.value === formState.resourcePreset)
    if (preset) {
      rows.push({ label: "Resource Preset", value: preset.label })
    }
  }

  return rows
}

function CatalogMcpConfigCard({
  projectId,
  template,
  formState,
  onConfigure,
}: CatalogMcpConfigCardProps): ReactElement {
  const expectedProvider = template.runtimeCredential?.type
  const runtimeCredentialId = formState.runtimeCredentialId
  const { data: credentials = [] } = useListCredentialsQuery(
    { projectId: projectId ?? "", provider: expectedProvider },
    {
      skip: !projectId || !expectedProvider || !runtimeCredentialId,
    },
  )
  const runtimeCredentialName = runtimeCredentialId
    ? credentials.find((c) => c.id === runtimeCredentialId)?.name
    : undefined

  const details = formState.mcpConfigSaved
    ? buildSavedDetails(template, formState, runtimeCredentialName)
    : []

  const connectionStatus: McpConnectionStatus =
    formState.catalogMcpConnectionStatus === "successful"
      ? "connected"
      : formState.catalogMcpConnectionStatus === "failed"
        ? "error"
        : "not-configured"

  return (
    <Card>
      <CardHeader
        title={ADD_TOOL_STRINGS.MCP_SECTION_TITLE}
        subtitle={ADD_TOOL_STRINGS.MCP_SECTION_SUBTITLE}
        hasSeparator
      />
      <CardContent>
        <div className="catalog-config__form">
          <ToolsetMcpCard
            connectionStatus={connectionStatus}
            configureLabel={ADD_TOOL_STRINGS.CONFIGURE_ACTION_LABEL}
            onConfigure={onConfigure}
            details={details}
          />
        </div>
      </CardContent>
    </Card>
  )
}

export { CatalogMcpConfigCard }
export type { CatalogMcpConfigCardProps }
