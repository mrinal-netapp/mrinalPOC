import { useEffect, useRef, type ReactElement } from "react"
import { useNavigate, useParams } from "react-router"

import { toast } from "@/ui-lib/base-components/toast/toast"
import { ROUTES } from "@/routes/routes.consts"
import { useAppDispatch, useAppSelector } from "@/store"
import { projectContextSelector } from "@/store/selectors/project-context.selector"
import { AddEntityForm } from "@/components/common/add-entity-form/add-entity-form"
import { Card } from "@/ui-lib/base-components/card/card"
import { CardHeader } from "@/ui-lib/base-components/card/card.header"
import { CardContent } from "@/ui-lib/base-components/card/card.content"
import { FormFieldErrorBlock } from "@/ui-lib/base-components/form"

import { CustomTabContent } from "../add-tool/custom/custom-tab-content"
import { ToolsetMcpCard } from "../toolset-mcp-card/toolset-mcp-card"
import type { McpConnectionStatus } from "../toolset-mcp-card/toolset-mcp-card"
import { ADD_TOOL_STRINGS } from "../add-tool/add-tool.consts"
import { initializeEditToolForm } from "../actions"
import { loadEditToolForm } from "../reducer"
import type { EditToolFormState } from "../toolset.types"
import { EditConfigDialog } from "./edit-config-dialog"
import { useEditToolFormState } from "./edit-tool.actions"
import { resolveDisplayedForwardedHeaders } from "../platform-mcp-defaults"
import {
  useGetMcpServerQuery,
  useUpdateMcpServerMutation,
  type McpServerRecord,
} from "../toolset.api"

type EditUpdateError = {
  data?: {
    message?: string
    error?: string
    errors?: Array<{ msg?: string }>
  }
}

function extractUpdateError(error: unknown): string {
  const parsed = error as EditUpdateError
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
  return "Failed to update toolset"
}

/** Maps a fetched MCP server record into the edit form's initial values. */
function mapServerToFormPayload(server: McpServerRecord) {
  const staticEntries = Object.entries(server.staticHeaders ?? {})
  const forwarded = resolveDisplayedForwardedHeaders(server.deploymentType, server.extraHeaders)
  return {
    name: server.name,
    description: server.description ?? "",
    labels: server.labels ?? [],
    addCustomHeaders: staticEntries.length > 0,
    customHeaders: staticEntries.length > 0
      ? staticEntries.map(([key, value]) => ({ key, value }))
      : [{ key: "", value: "" }],
    addForwardedHeaders: forwarded.length > 0,
    forwardedHeaders: forwarded.length > 0 ? forwarded : [""],
    applyRateLimiting: false,
    callsPerMinute: "",
    configFields: [],
  }
}

/** Builds the PUT body from the current edit form state. */
function buildUpdateBody(form: EditToolFormState): Record<string, unknown> {
  const staticHeaders = form.addCustomHeaders
    ? Object.fromEntries(
        form.customHeaders
          .map((header) => [header.key.trim(), header.value] as const)
          .filter(([key]) => key.length > 0),
      )
    : {}
  const extraHeaders = form.addForwardedHeaders
    ? Array.from(
        new Set(
          form.forwardedHeaders
            .map((name) => name.trim())
            .filter((name) => name.length > 0),
        ),
      )
    : []
  return {
    description: form.description.trim(),
    labels: form.selectedLabels,
    staticHeaders,
    extraHeaders,
  }
}

function EditTool(): ReactElement {
  const { toolId } = useParams<{ toolId: string }>()
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const projectId = useAppSelector(projectContextSelector.activeProjectId)

  const formState = useEditToolFormState()
  const {
    name,
    description,
    labelItems,
    selectedLabels,
    configFields,
    configDialogOpen,
    addCustomHeaders,
    customHeaders,
    addForwardedHeaders,
    forwardedHeaders,
    applyRateLimiting,
    callsPerMinute,
    submitted,
    setDescription,
    onLabelChange,
    onAddLabel,
    openConfigDialog,
    closeConfigDialog,
    setConfigFieldValue,
    setAddCustomHeaders,
    setCustomHeaders,
    setAddForwardedHeaders,
    setForwardedHeaders,
    setApplyRateLimiting,
    setCallsPerMinute,
    setSubmitted,
    requiredConfigMissing,
  } = formState

  const { data: server } = useGetMcpServerQuery(
    { projectId: projectId ?? "", id: toolId ?? "" },
    { skip: !projectId || !toolId },
  )
  const [updateMcpServer, { isLoading: isUpdating }] = useUpdateMcpServerMutation()

  useEffect(() => {
    if (toolId) {
      dispatch(initializeEditToolForm(toolId))
    }
  }, [dispatch, toolId])

  // Populate the form once the server record arrives (guarded so user edits
  // are not clobbered on subsequent re-renders / cache updates).
  const loadedIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (server && loadedIdRef.current !== server.id) {
      loadedIdRef.current = server.id
      dispatch(loadEditToolForm({ toolId: server.id, ...mapServerToFormPayload(server) }))
    }
  }, [dispatch, server])

  const goBack = (): void => {
    if (toolId) {
      navigate(`/${ROUTES.TOOLSET}/${toolId}`)
      return
    }
    navigate(`/${ROUTES.TOOLSET}`)
  }

  const handleSave = async (): Promise<void> => {
    setSubmitted(true)
    if (requiredConfigMissing) {
      toast.error("Please fill all required configuration fields")
      return
    }
    if (!projectId || !toolId) {
      toast.error("Select a project before saving")
      return
    }
    try {
      await updateMcpServer({
        projectId,
        id: toolId,
        body: buildUpdateBody(formState),
      }).unwrap()
    } catch (error: unknown) {
      toast.error(extractUpdateError(error))
      return
    }
    toast.success("Toolset updated successfully")
    navigate(`/${ROUTES.TOOLSET}`)
  }

  const handleConfigSave = (): void => {
    closeConfigDialog()
    toast.success("Configuration updated")
  }

  const connectionStatus: McpConnectionStatus = !requiredConfigMissing ? "connected" : "error"

  const forwardHeadersReadOnly = server?.deploymentType === "platform"

  const mcpDetails = server
    ? [
        ...(server.url ? [{ label: "Server", value: server.url }] : []),
        ...(server.authType ? [{ label: "Authentication type", value: server.authType }] : []),
      ]
    : configFields
        .filter((field) => field.value.trim())
        .map((field) => ({ label: field.label, value: field.value }))

  return (
    <>
      <AddEntityForm
        open
        title="Edit toolset"
        entityName="Toolset"
        entityDescription="Edit toolset for agents to perform actions during execution."
        addLabel={isUpdating ? "Saving…" : "Save"}
        cancelLabel="Cancel"
        onAdd={handleSave}
        onCancel={goBack}
        sections={[
          <Card key="details">
            <CardHeader
              title={ADD_TOOL_STRINGS.DETAILS_TITLE}
              subtitle="Provide the identifying information for this toolset."
              hasSeparator
            />
            <CardContent>
              <CustomTabContent
                name={name}
                description={description}
                labelItems={labelItems}
                selectedLabels={selectedLabels}
                onNameChange={() => {}}
                onDescriptionChange={setDescription}
                onLabelChange={onLabelChange}
                onAddLabel={onAddLabel}
                isNameDisabled
              />
            </CardContent>
          </Card>,

          <div key="mcp">
            <ToolsetMcpCard
              title={ADD_TOOL_STRINGS.MCP_SECTION_TITLE}
              subtitle={ADD_TOOL_STRINGS.MCP_SECTION_SUBTITLE}
              connectionStatus={connectionStatus}
              configureLabel="Modify"
              onConfigure={openConfigDialog}
              details={mcpDetails}
            />
            {submitted && requiredConfigMissing && (
              <FormFieldErrorBlock message="Required configuration fields are missing" />
            )}
          </div>,
        ]}
      />

      <EditConfigDialog
        open={configDialogOpen}
        fields={configFields}
        onFieldChange={setConfigFieldValue}
        addCustomHeaders={addCustomHeaders}
        customHeaders={customHeaders}
        onCustomHeadersToggle={setAddCustomHeaders}
        onCustomHeaderValuesChange={setCustomHeaders}
        addForwardedHeaders={addForwardedHeaders}
        forwardedHeaders={forwardedHeaders}
        onForwardedHeadersToggle={setAddForwardedHeaders}
        onForwardedHeaderValuesChange={setForwardedHeaders}
        forwardHeadersReadOnly={forwardHeadersReadOnly}
        applyRateLimiting={applyRateLimiting}
        callsPerMinute={callsPerMinute}
        onRateLimitingToggle={setApplyRateLimiting}
        onCallsPerMinuteChange={setCallsPerMinute}
        onSave={handleConfigSave}
        onClose={closeConfigDialog}
      />
    </>
  )
}

export { EditTool }
