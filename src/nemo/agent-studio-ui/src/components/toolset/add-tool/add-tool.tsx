import { useEffect, useState, type ReactElement } from "react"
import { useNavigate } from "react-router"

import { toast } from "@/ui-lib/base-components/toast/toast"
import { ROUTES } from "@/routes/routes.consts"
import { useAppDispatch } from "@/store"
import { useListCredentialsQuery } from "@/routes/pages/credentials/credential-api.slice"
import { useProject } from "@/contexts/project/hooks/useProject"
import { AddEntityForm } from "@/components/common/add-entity-form/add-entity-form"
import { TabDetailCard } from "@/components/common/tab-detail-card/tab-detail-card"
import { FloatingLayerContext } from "@/ui-lib/lib/floating-layer-context"

import { CustomTabContent } from "./custom/custom-tab-content"
import { CustomMcpConfigDialog } from "./custom/custom-mcp-config-dialog"
import { CatalogTabContent } from "./catalog/catalog-tab-content"
import { CatalogMcpConfigCard } from "./catalog/catalog-mcp-config-card"
import { CatalogMcpConfigDialog } from "./catalog/catalog-mcp-config-dialog"
import { ToolsetMcpCard } from "../toolset-mcp-card/toolset-mcp-card"
import type { McpConnectionStatus } from "../toolset-mcp-card/toolset-mcp-card"
import { FormFieldErrorBlock } from "@/ui-lib/base-components/form"
import { ADD_TOOL_STRINGS } from "./add-tool.consts"
import { CATALOG_TEMPLATES } from "./catalog/catalog.consts"
import { initializeAddToolForm } from "../actions"
import { useAddToolFormState } from "./add-tool.actions"
import { useCreateMcpServerMutation, useValidateManagedMcpConfigMutation, useValidateMcpConnectionMutation } from "../toolset.api"
import type { AddToolMcpConfig } from "./add-tool.types"

type ConnectionParam = { name: string; value: string }
type ToolsetCreateError = {
  data?: {
    message?: string
    error?: string
    errors?: Array<{ msg?: string }>
  }
}

function buildValidationBody(config: AddToolMcpConfig): Record<string, unknown> {
  const headerParams: ConnectionParam[] = []
  const staticHeaders = config.addCustomHeaders
    ? Object.fromEntries(
      config.customHeaders
        .map((item) => [item.key.trim(), item.value])
        .filter(([key]) => key.length > 0),
    )
    : {}

  if (config.authType === "api_key" && config.apiKey.trim()) {
    headerParams.push({
      name: (config.headerName || "x-api-key").trim(),
      value: config.apiKey.trim(),
    })
  }

  if (config.authType === "bearer_token" && config.bearerToken.trim()) {
    headerParams.push({
      name: "Authorization",
      value: `Bearer ${config.bearerToken.trim()}`,
    })
  }

  return {
    deploymentType: "remote",
    transport: config.connectionType === "streamable_http" ? "streamable-http" : "sse",
    url: config.serverUrl.trim(),
    staticHeaders,
    headerParams,
  }
}

function mapAuthType(authType: AddToolMcpConfig["authType"]): "none" | "api_key" | "bearer_token" | "oauth2" {
  if (authType === "api_key") return "api_key"
  if (authType === "bearer_token") return "bearer_token"
  if (authType === "no_auth") return "none"
  return "oauth2"
}

function normalizeToolsetName(name: string): string {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9_ ]/g, "")
    .replace(/\s+/g, "_")
}

function resolveCatalogId(templateId: string): string | undefined {
  const aliases: Record<string, string | undefined> = {
    azure_netapp_files: "anf_mcp",
    // Amazon FSx for NetApp ONTAP speaks the ONTAP REST API, so it reuses the
    // NetApp ONTAP backend image and takes a NetApp ONTAP credential (there is
    // no dedicated FSxN MCP image).
    fsxn: "ontap_mcp_official",
    google_cloud_netapp_volumes: "gcnv_mcp",
    google_cloud_netapp_volumes_logs: "gcnv_logs_mcp",
    azure_netapp_files_logs: "anf_logs_mcp",
    netapp_ontap: "ontap_mcp_official",
    analytics_datasets: "analytics_datasets_mcp",
    duckdb_iceberg: "duckdb_iceberg",
    postgres: "postgres_mcp",
    github: "github_mcp",
    web_search: "web_search_mcp",
  }
  return aliases[templateId]
}

function extractCreateToolsetError(error: unknown): string {
  const parsed = error as ToolsetCreateError
  if (typeof parsed?.data?.message === "string" && parsed.data.message.trim()) {
    return parsed.data.message
  }
  if (typeof parsed?.data?.error === "string" && parsed.data.error.trim()) {
    return parsed.data.error
  }
  if (Array.isArray(parsed?.data?.errors) && parsed.data.errors.length > 0) {
    const first = parsed.data.errors[0]
    if (typeof first?.msg === "string" && first.msg.trim()) return first.msg
  }
  return "Failed to create toolset"
}

function buildForwardedHeaders(
  addForwardedHeaders: boolean,
  forwardedHeaders: string[],
): string[] | undefined {
  if (!addForwardedHeaders) return undefined
  const names = Array.from(
    new Set(forwardedHeaders.map((name) => name.trim()).filter((name) => name.length > 0)),
  )
  return names.length > 0 ? names : undefined
}

function buildCreateBody(name: string, description: string, labels: string[], config: AddToolMcpConfig): Record<string, unknown> {
  const validationPayload = buildValidationBody(config)
  const extraHeaders = buildForwardedHeaders(config.addForwardedHeaders, config.forwardedHeaders)
  return {
    name: normalizeToolsetName(name),
    description: description.trim() || undefined,
    labels,
    ...validationPayload,
    ...(extraHeaders ? { extraHeaders } : {}),
    authType: mapAuthType(config.authType),
  }
}

function buildValidateCatalogBody(
  templateId: string,
  catalog: {
    envVarValues: Record<string, string>
    runtimeCredentialId: string
    resourcePreset: string
  },
): Record<string, unknown> {
  const catalogId = resolveCatalogId(templateId)
  if (!catalogId) {
    throw new Error("This catalog template is not yet supported by backend catalog deployment.")
  }

  const runtimeCredentialId = catalog.runtimeCredentialId.trim()

  return {
    catalogId,
    ...(runtimeCredentialId ? { runtimeCredentialId } : {}),
    managedConfig: {
      resourcePreset: catalog.resourcePreset,
      envOverrides: catalog.envVarValues,
    },
  }
}

function buildCreateCatalogBody(
  templateId: string,
  name: string,
  description: string,
  labels: string[],
  catalog: {
    envVarValues: Record<string, string>
    runtimeCredentialId: string
    resourcePreset: string
    addCustomHeaders: boolean
    customHeaders: Array<{ key: string; value: string }>
    applyRateLimiting: boolean
    callsPerMinute: string
  },
): Record<string, unknown> {
  const staticHeaders = catalog.addCustomHeaders
    ? Object.fromEntries(
      catalog.customHeaders
        .map((item) => [item.key.trim(), item.value])
        .filter(([key]) => key.length > 0),
    )
    : undefined

  const timeout =
    catalog.applyRateLimiting && catalog.callsPerMinute.trim()
      ? Math.max(1, Number.parseInt(catalog.callsPerMinute, 10))
      : undefined

  const catalogId = resolveCatalogId(templateId)
  if (!catalogId) {
    throw new Error("This catalog template is not yet supported by backend catalog deployment.")
  }

  const runtimeCredentialId = catalog.runtimeCredentialId.trim()

  return {
    deploymentType: "managed",
    catalogId,
    name: normalizeToolsetName(name),
    description: description.trim() || undefined,
    labels,
    managedConfig: {
      resourcePreset: catalog.resourcePreset,
      envOverrides: catalog.envVarValues,
    },
    ...(runtimeCredentialId ? { runtimeCredentialId } : {}),
    ...(staticHeaders ? { staticHeaders } : {}),
    ...(timeout ? { timeout } : {}),
  }
}

function AddTool(): ReactElement {
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const { activeProject } = useProject()
  const [createMcpServer] = useCreateMcpServerMutation()
  const [validateMcpConnection] = useValidateMcpConnectionMutation()
  const [validateManagedMcpConfig] = useValidateManagedMcpConfigMutation()

  const {
    activeTabId,
    name,
    description,
    labelItems,
    selectedLabels,
    catalog,
    mcpConfigDialogOpen,
    mcpConfigDraft,
    savedMcpConfig,
    mcpConnectionStatus,
    mcpValidationMessage,
    setActiveTabId,
    setName,
    setDescription,
    onLabelChange,
    onAddLabel,
    openMcpDialog,
    closeMcpDialog,
    setMcpDraft,
    setMcpCustomHeaders,
    setMcpForwardedHeaders,
    saveMcpDialog,
    setMcpValidationResult,
    onSelectCatalogTemplate,
    onCatalogNameChange,
    onCatalogDescriptionChange,
    onCatalogEnvVarValueChange,
    onCatalogRuntimeCredentialChange,
    onCatalogResourcePresetChange,
    onCatalogCustomHeadersToggle,
    onCatalogCustomHeaderValuesChange,
    onCatalogRateLimitingChange,
    onCatalogCallsPerMinuteChange,
    openCatalogMcpDialog,
    closeCatalogMcpDialog,
    saveCatalogMcpDialog,
    setCatalogMcpValidationResult,
  } = useAddToolFormState()

  useEffect(() => {
    dispatch(initializeAddToolForm())
  }, [dispatch])

  const selectedCatalogProvider = CATALOG_TEMPLATES.find(
    (t) => t.id === catalog.selectedTemplateId,
  )?.runtimeCredential?.type

  const { data: runtimeCredentials = [], isFetching: isLoadingRuntimeCredentials } =
    useListCredentialsQuery(
      { projectId: activeProject?.id ?? "", provider: selectedCatalogProvider },
      { skip: !activeProject?.id || !selectedCatalogProvider },
    )

  const runtimeCredentialItems = runtimeCredentials.map((credential) => ({
    key: credential.id,
    value: credential.id,
    label: credential.name,
  }))

  const isCustomTab = activeTabId === "custom"
  const isCatalogTab = activeTabId === "catalog"
  const [submitted, setSubmitted] = useState(false)

  const isCatalogAddDisabled = !catalog.selectedTemplateId || !catalog.catalogName.trim() || !catalog.mcpConfigSaved
  const isCustomAddDisabled = !name.trim() || !savedMcpConfig
  const isAddDisabled = isCustomTab ? isCustomAddDisabled : isCatalogAddDisabled

  const goBack = (): void => { navigate(`/${ROUTES.TOOLSET}`) }
  const handleAdd = async (): Promise<void> => {
    setSubmitted(true)
    if (isAddDisabled) return
    if (!activeProject?.id) return
    const selectedCatalogTemplate = CATALOG_TEMPLATES.find((t) => t.id === catalog.selectedTemplateId)
    const isCatalogFlow = isCatalogTab && selectedCatalogTemplate != null
    if (!isCatalogFlow && (!savedMcpConfig || !name.trim())) return
    if (
      isCatalogFlow &&
      selectedCatalogTemplate.runtimeCredential?.isRequired &&
      !catalog.runtimeCredentialId.trim()
    ) {
      toast.error(
        `Select a '${selectedCatalogTemplate.runtimeCredential.type}' runtime credential for '${selectedCatalogTemplate.name}'.`,
      )
      return
    }
    try {
      const customConfig = savedMcpConfig
      const body = isCatalogFlow
        ? buildCreateCatalogBody(
          selectedCatalogTemplate.id,
          catalog.catalogName,
          catalog.catalogDescription,
          selectedLabels,
          {
            envVarValues: catalog.envVarValues,
            runtimeCredentialId: catalog.runtimeCredentialId,
            resourcePreset: catalog.resourcePreset,
            addCustomHeaders: catalog.addCustomHeaders,
            customHeaders: catalog.customHeaders,
            applyRateLimiting: catalog.applyRateLimiting,
            callsPerMinute: catalog.callsPerMinute,
          },
        )
        : buildCreateBody(name, description, selectedLabels, customConfig!)
      await createMcpServer({
        projectId: activeProject.id,
        body,
      }).unwrap()
    } catch (error: unknown) {
      const message = extractCreateToolsetError(error)
      toast.error(message)
      return
    }
    toast.success("Toolset created successfully")
    navigate(`/${ROUTES.TOOLSET}`)
  }

  const connectionStatus: McpConnectionStatus =
    mcpConnectionStatus === "successful"
      ? "connected"
      : mcpConnectionStatus === "failed"
        ? "error"
        : savedMcpConfig
          ? "connected"
          : "not-configured"

  const selectedTemplate = CATALOG_TEMPLATES.find((t) => t.id === catalog.selectedTemplateId)

  const mcpDetails = savedMcpConfig
    ? [
        { label: "Server", value: savedMcpConfig.serverUrl },
        { label: "Authentication type", value: savedMcpConfig.authType },
        ...(savedMcpConfig.applyRateLimiting ? [{ label: "Calls per minute", value: savedMcpConfig.callsPerMinute }] : []),
      ]
    : []

  const [isValidatingMcp, setIsValidatingMcp] = useState(false)
  const [isValidatingCatalogMcp, setIsValidatingCatalogMcp] = useState(false)

  const handleSaveCatalogMcpDialog = async (): Promise<boolean> => {
    if (!activeProject?.id) {
      const message = "Select a project before validating MCP configuration"
      setCatalogMcpValidationResult("failed", message)
      toast.error(message)
      return false
    }

    const template = CATALOG_TEMPLATES.find((t) => t.id === catalog.selectedTemplateId)
    if (!template) {
      const message = "Select a catalog template before validating MCP configuration"
      setCatalogMcpValidationResult("failed", message)
      toast.error(message)
      return false
    }

    setIsValidatingCatalogMcp(true)
    try {
      const response = await validateManagedMcpConfig({
        projectId: activeProject.id,
        body: buildValidateCatalogBody(template.id, {
          envVarValues: catalog.envVarValues,
          runtimeCredentialId: catalog.runtimeCredentialId,
          resourcePreset: catalog.resourcePreset,
        }),
      }).unwrap()

      if (!response.success) {
        const message = response.message || "MCP configuration validation failed"
        setCatalogMcpValidationResult("failed", message)
        toast.error(message)
        return false
      }

      saveCatalogMcpDialog()
      setCatalogMcpValidationResult("successful", response.message || "Connected")
      toast.success(response.message || "MCP configuration validated")
      return true
    } catch (error: unknown) {
      const parsed = error as ToolsetCreateError
      const message = parsed?.data?.message || parsed?.data?.error || "MCP configuration validation failed"
      setCatalogMcpValidationResult("failed", message)
      toast.error(message)
      return false
    } finally {
      setIsValidatingCatalogMcp(false)
    }
  }

  const handleSaveMcpDialog = async (): Promise<boolean> => {
    if (!activeProject?.id) {
      const message = "Select a project before validating MCP connection"
      setMcpValidationResult("failed", message)
      toast.error(message)
      return false
    }

    setIsValidatingMcp(true)
    try {
      const response = await validateMcpConnection({
        projectId: activeProject.id,
        body: buildValidationBody(mcpConfigDraft),
      }).unwrap()

      if (!response.success) {
        const message = response.message || "MCP validation failed"
        setMcpValidationResult("failed", message)
        toast.error(message)
        return false
      }

      saveMcpDialog()
      setMcpValidationResult("successful", response.message || "Connected")
      toast.success(response.message || "MCP connection validated")
      return true
    } catch (error: unknown) {
      const parsed = error as ToolsetCreateError
      const message = parsed?.data?.message || parsed?.data?.error || "MCP validation failed"
      setMcpValidationResult("failed", message)
      toast.error(message)
      return false
    } finally {
      setIsValidatingMcp(false)
    }
  }

  return (
    <>
      <AddEntityForm
        open
        title={ADD_TOOL_STRINGS.PAGE_TITLE}
        entityName={ADD_TOOL_STRINGS.TOOL_TITLE}
        entityDescription={ADD_TOOL_STRINGS.TOOL_SUBTITLE}
        addLabel={ADD_TOOL_STRINGS.SUBMIT_LABEL}
        cancelLabel={ADD_TOOL_STRINGS.CANCEL_LABEL}
        onAdd={handleAdd}
        onCancel={goBack}
        sections={[
          <FloatingLayerContext.Provider key="details" value={{ zIndex: 200 }}>
            <TabDetailCard
              cardClassName="toolset-details-card"
              title={ADD_TOOL_STRINGS.DETAILS_TITLE}
              subtitle={ADD_TOOL_STRINGS.DETAILS_SUBTITLE}
              ariaLabel="Tool type"
              tabs={[
                { id: "catalog", label: ADD_TOOL_STRINGS.TAB_ADD_FROM_CATALOG },
                { id: "custom", label: ADD_TOOL_STRINGS.TAB_ADD_CUSTOM_TOOL },
              ]}
              activeTabId={activeTabId}
              onTabChange={(id) => { if (id === "catalog" || id === "custom") setActiveTabId(id) }}
              panels={[
                {
                  tabId: "custom",
                  content: (
                    <CustomTabContent
                      name={name}
                      description={description}
                      labelItems={labelItems}
                      selectedLabels={selectedLabels}
                      onNameChange={setName}
                      onDescriptionChange={setDescription}
                      onLabelChange={onLabelChange}
                      onAddLabel={onAddLabel}
                      showValidation={submitted}
                    />
                  ),
                },
                {
                  tabId: "catalog",
                  content: (
                    <CatalogTabContent
                      formState={catalog}
                      labelItems={labelItems}
                      selectedLabels={selectedLabels}
                      onSelectTemplate={onSelectCatalogTemplate}
                      onNameChange={onCatalogNameChange}
                      onDescriptionChange={onCatalogDescriptionChange}
                      onLabelChange={onLabelChange}
                      onAddLabel={onAddLabel}
                      showValidation={submitted}
                    />
                  ),
                },
              ]}
            />
          </FloatingLayerContext.Provider>,

          isCustomTab ? (
            <div key="mcp">
              <ToolsetMcpCard
                title={ADD_TOOL_STRINGS.MCP_SECTION_TITLE}
                subtitle={ADD_TOOL_STRINGS.MCP_SECTION_SUBTITLE}
                connectionStatus={connectionStatus}
                configureLabel={ADD_TOOL_STRINGS.CONFIGURE_ACTION_LABEL}
                onConfigure={openMcpDialog}
                details={mcpDetails}
              />
              {mcpConnectionStatus === "failed" && mcpValidationMessage && (
                <FormFieldErrorBlock message={mcpValidationMessage} />
              )}
              {submitted && !savedMcpConfig && (
                <FormFieldErrorBlock message="MCP server configuration is required" />
              )}
            </div>
          ) : undefined,

          isCatalogTab && selectedTemplate ? (
            <div key="catalog-mcp">
              <CatalogMcpConfigCard
                projectId={activeProject?.id}
                template={selectedTemplate}
                formState={catalog}
                onConfigure={openCatalogMcpDialog}
              />
              {catalog.catalogMcpConnectionStatus === "failed" && catalog.catalogMcpValidationMessage && (
                <FormFieldErrorBlock message={catalog.catalogMcpValidationMessage} />
              )}
              {submitted && !catalog.mcpConfigSaved && (
                <FormFieldErrorBlock message="MCP server configuration is required" />
              )}
            </div>
          ) : undefined,
        ]}
      />

      <CustomMcpConfigDialog
        open={mcpConfigDialogOpen}
        mcpConfigDraft={mcpConfigDraft}
        onClose={closeMcpDialog}
        onDraftChange={setMcpDraft}
        onCustomHeadersChange={setMcpCustomHeaders}
        onForwardedHeadersChange={setMcpForwardedHeaders}
        onSave={handleSaveMcpDialog}
        isValidating={isValidatingMcp}
        validationStatus={mcpConnectionStatus}
        validationMessage={mcpValidationMessage}
      />

      {selectedTemplate && (
        <CatalogMcpConfigDialog
          open={catalog.mcpConfigDialogOpen}
          template={selectedTemplate}
          formState={catalog}
          credentialItems={runtimeCredentialItems}
          isLoadingCredentials={isLoadingRuntimeCredentials}
          onClose={closeCatalogMcpDialog}
          onEnvVarValueChange={onCatalogEnvVarValueChange}
          onRuntimeCredentialChange={onCatalogRuntimeCredentialChange}
          onResourcePresetChange={onCatalogResourcePresetChange}
          onCustomHeadersToggle={onCatalogCustomHeadersToggle}
          onCustomHeaderValuesChange={onCatalogCustomHeaderValuesChange}
          onRateLimitingChange={onCatalogRateLimitingChange}
          onCallsPerMinuteChange={onCatalogCallsPerMinuteChange}
          onSave={handleSaveCatalogMcpDialog}
          isValidating={isValidatingCatalogMcp}
          validationStatus={catalog.catalogMcpConnectionStatus}
          validationMessage={catalog.catalogMcpValidationMessage}
        />
      )}
    </>
  )
}

export { AddTool }
