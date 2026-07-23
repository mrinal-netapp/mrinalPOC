import { useCallback } from "react"
import { useAppDispatch, useAppSelector } from "@/store"
import type { SelectDropdownValue } from "@/ui-lib/base-components/select-dropdown/select-dropdown.types"

import {
  addAddToolLabel,
  closeCatalogMcpConfigDialog,
  closeMcpConfigDialog,
  openCatalogMcpConfigDialog,
  openMcpConfigDialog,
  saveCatalogMcpConfig,
  saveMcpConfig,
  selectCatalogTemplate,
  setCatalogMcpValidationResult,
  setCatalogDescription,
  setCatalogEnvVarValue,
  setCatalogRuntimeCredentialId,
  setCatalogName,
  setCatalogResourcePreset,
  setCatalogCustomHeaders,
  setCatalogCustomHeaderValues,
  setCatalogRateLimiting,
  setCatalogCallsPerMinute,
  setCatalogRetryCount,
  setCatalogTimeoutMs,
  setCatalogRetryTimeoutExpanded,
  setAddToolActiveTabId,
  setAddToolDescription,
  setAddToolName,
  setAddToolSelectedLabels,
  setMcpConfigCustomHeaders,
  setMcpConfigForwardedHeaders,
  setMcpConfigDraft,
  setMcpValidationResult,
} from "../reducer"
import { toolsetSelector } from "../selectors"
import type {
  AddToolMcpConfig,
  AddToolMcpConnectionStatus,
  AddToolMode,
  AddToolState,
} from "./add-tool.types"
import type {
  CatalogResourcePreset,
  CatalogTemplateId,
} from "./catalog/catalog.types"

type UseAddToolFormStateResult = AddToolState & {
  setActiveTabId: (value: AddToolMode) => void
  setName: (value: string) => void
  setDescription: (value: string) => void
  onLabelChange: (value: SelectDropdownValue) => void
  onAddLabel: (value: string) => void
  openMcpDialog: () => void
  closeMcpDialog: () => void
  setMcpDraft: (value: Partial<AddToolMcpConfig>) => void
  setMcpCustomHeaders: (value: Array<{ key: string; value: string }>) => void
  setMcpForwardedHeaders: (value: string[]) => void
  saveMcpDialog: () => void
  setMcpValidationResult: (status: AddToolMcpConnectionStatus, message: string | null) => void
  onSelectCatalogTemplate: (templateId: CatalogTemplateId) => void
  onCatalogNameChange: (value: string) => void
  onCatalogDescriptionChange: (value: string) => void
  onCatalogEnvVarValueChange: (key: string, value: string) => void
  onCatalogRuntimeCredentialChange: (credentialId: string) => void
  onCatalogResourcePresetChange: (preset: CatalogResourcePreset) => void
  onCatalogCustomHeadersToggle: (enabled: boolean) => void
  onCatalogCustomHeaderValuesChange: (headers: Array<{ key: string; value: string }>) => void
  onCatalogRateLimitingChange: (enabled: boolean) => void
  onCatalogCallsPerMinuteChange: (value: string) => void
  onCatalogRetryCountChange: (value: string) => void
  onCatalogTimeoutMsChange: (value: string) => void
  onCatalogRetryTimeoutExpandedChange: (expanded: boolean) => void
  openCatalogMcpDialog: () => void
  closeCatalogMcpDialog: () => void
  saveCatalogMcpDialog: () => void
  setCatalogMcpValidationResult: (status: AddToolMcpConnectionStatus, message: string | null) => void
}

function useAddToolFormState(): UseAddToolFormStateResult {
  const dispatch = useAppDispatch()
  const formState = useAppSelector(toolsetSelector.addToolFormState)

  const setActiveTabId = useCallback((value: AddToolMode): void => {
    dispatch(setAddToolActiveTabId(value))
  }, [dispatch])

  const setName = useCallback((value: string): void => {
    dispatch(setAddToolName(value))
  }, [dispatch])

  const setDescription = useCallback((value: string): void => {
    dispatch(setAddToolDescription(value))
  }, [dispatch])

  const onLabelChange = useCallback((value: SelectDropdownValue): void => {
    if (Array.isArray(value)) {
      dispatch(setAddToolSelectedLabels(value.map((item) => String(item))))
      return
    }
    dispatch(setAddToolSelectedLabels(value !== null && value !== undefined ? [String(value)] : []))
  }, [dispatch])

  const onAddLabel = useCallback((value: string): void => {
    dispatch(addAddToolLabel(value))
  }, [dispatch])

  const openMcpDialog = useCallback((): void => {
    dispatch(openMcpConfigDialog())
  }, [dispatch])

  const closeMcpDialog = useCallback((): void => {
    dispatch(closeMcpConfigDialog())
  }, [dispatch])

  const setMcpDraft = useCallback((value: Partial<AddToolMcpConfig>): void => {
    dispatch(setMcpConfigDraft(value))
  }, [dispatch])

  const setMcpCustomHeaders = useCallback((value: Array<{ key: string; value: string }>): void => {
    dispatch(setMcpConfigCustomHeaders(value))
  }, [dispatch])

  const setMcpForwardedHeaders = useCallback((value: string[]): void => {
    dispatch(setMcpConfigForwardedHeaders(value))
  }, [dispatch])

  const saveMcpDialog = useCallback((): void => {
    dispatch(saveMcpConfig())
  }, [dispatch])

  const updateMcpValidationResult = useCallback((status: AddToolMcpConnectionStatus, message: string | null): void => {
    dispatch(setMcpValidationResult({ status, message }))
  }, [dispatch])

  const onSelectCatalogTemplate = useCallback((templateId: CatalogTemplateId): void => {
    dispatch(selectCatalogTemplate(templateId))
  }, [dispatch])

  const onCatalogNameChange = useCallback((value: string): void => {
    dispatch(setCatalogName(value))
  }, [dispatch])

  const onCatalogDescriptionChange = useCallback((value: string): void => {
    dispatch(setCatalogDescription(value))
  }, [dispatch])

  const onCatalogEnvVarValueChange = useCallback((key: string, value: string): void => {
    dispatch(setCatalogEnvVarValue({ key, value }))
  }, [dispatch])

  const onCatalogRuntimeCredentialChange = useCallback((credentialId: string): void => {
    dispatch(setCatalogRuntimeCredentialId(credentialId))
  }, [dispatch])

  const onCatalogResourcePresetChange = useCallback((preset: CatalogResourcePreset): void => {
    dispatch(setCatalogResourcePreset(preset))
  }, [dispatch])

  const onCatalogCustomHeadersToggle = useCallback((enabled: boolean): void => {
    dispatch(setCatalogCustomHeaders(enabled))
  }, [dispatch])

  const onCatalogCustomHeaderValuesChange = useCallback((headers: Array<{ key: string; value: string }>): void => {
    dispatch(setCatalogCustomHeaderValues(headers))
  }, [dispatch])

  const onCatalogRateLimitingChange = useCallback((enabled: boolean): void => {
    dispatch(setCatalogRateLimiting(enabled))
  }, [dispatch])

  const onCatalogCallsPerMinuteChange = useCallback((value: string): void => {
    dispatch(setCatalogCallsPerMinute(value))
  }, [dispatch])

  const onCatalogRetryCountChange = useCallback((value: string): void => {
    dispatch(setCatalogRetryCount(value))
  }, [dispatch])

  const onCatalogTimeoutMsChange = useCallback((value: string): void => {
    dispatch(setCatalogTimeoutMs(value))
  }, [dispatch])

  const onCatalogRetryTimeoutExpandedChange = useCallback((expanded: boolean): void => {
    dispatch(setCatalogRetryTimeoutExpanded(expanded))
  }, [dispatch])

  const openCatalogMcpDialog = useCallback((): void => {
    dispatch(openCatalogMcpConfigDialog())
  }, [dispatch])

  const closeCatalogMcpDialog = useCallback((): void => {
    dispatch(closeCatalogMcpConfigDialog())
  }, [dispatch])

  const saveCatalogMcpDialog = useCallback((): void => {
    dispatch(saveCatalogMcpConfig())
  }, [dispatch])

  const updateCatalogMcpValidationResult = useCallback((
    status: AddToolMcpConnectionStatus,
    message: string | null,
  ): void => {
    dispatch(setCatalogMcpValidationResult({ status, message }))
  }, [dispatch])

  return {
    ...formState,
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
    setMcpValidationResult: updateMcpValidationResult,
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
    onCatalogRetryCountChange,
    onCatalogTimeoutMsChange,
    onCatalogRetryTimeoutExpandedChange,
    openCatalogMcpDialog,
    closeCatalogMcpDialog,
    saveCatalogMcpDialog,
    setCatalogMcpValidationResult: updateCatalogMcpValidationResult,
  }
}

export { useAddToolFormState }
