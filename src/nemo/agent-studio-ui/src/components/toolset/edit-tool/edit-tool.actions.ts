import { useCallback } from "react"
import { useAppDispatch, useAppSelector } from "@/store"
import type { SelectDropdownValue } from "@/ui-lib/base-components/select-dropdown/select-dropdown.types"

import {
  addEditToolLabel,
  setEditAddCustomHeaders,
  setEditAddForwardedHeaders,
  setEditApplyRateLimiting,
  setEditCallsPerMinute,
  setEditConfigDialogOpen,
  setEditConfigFieldValue,
  setEditCustomHeaders,
  setEditForwardedHeaders,
  setEditDescription,
  setEditSelectedLabels,
  setEditSubmitted,
} from "../reducer"
import { toolsetSelector } from "../selectors"
import type { EditToolFormState } from "../toolset.types"
import type { ToolsetConfigField } from "./edit-tool.types"

type UseEditToolFormStateResult = EditToolFormState & {
  setDescription: (value: string) => void
  onLabelChange: (value: SelectDropdownValue) => void
  onAddLabel: (value: string) => void
  openConfigDialog: () => void
  closeConfigDialog: () => void
  setConfigFieldValue: (key: string, value: string) => void
  setAddCustomHeaders: (value: boolean) => void
  setCustomHeaders: (value: EditToolFormState["customHeaders"]) => void
  setAddForwardedHeaders: (value: boolean) => void
  setForwardedHeaders: (value: string[]) => void
  setApplyRateLimiting: (value: boolean) => void
  setCallsPerMinute: (value: string) => void
  setSubmitted: (value: boolean) => void
  requiredConfigMissing: boolean
  configFields: ToolsetConfigField[]
}

function useEditToolFormState(): UseEditToolFormStateResult {
  const dispatch = useAppDispatch()
  const formState = useAppSelector(toolsetSelector.editToolFormState)

  const requiredConfigMissing = formState.configFields
    .filter((field) => field.isRequired)
    .some((field) => !field.value.trim())

  const setDescription = useCallback((value: string): void => {
    dispatch(setEditDescription(value))
  }, [dispatch])

  const onLabelChange = useCallback((value: SelectDropdownValue): void => {
    if (Array.isArray(value)) {
      dispatch(setEditSelectedLabels(value.map((item) => String(item))))
      return
    }
    dispatch(setEditSelectedLabels(value !== null && value !== undefined ? [String(value)] : []))
  }, [dispatch])

  const onAddLabel = useCallback((value: string): void => {
    dispatch(addEditToolLabel(value))
  }, [dispatch])

  const openConfigDialog = useCallback((): void => {
    dispatch(setEditConfigDialogOpen(true))
  }, [dispatch])

  const closeConfigDialog = useCallback((): void => {
    dispatch(setEditConfigDialogOpen(false))
  }, [dispatch])

  const setConfigFieldValue = useCallback((key: string, value: string): void => {
    dispatch(setEditConfigFieldValue({ key, value }))
  }, [dispatch])

  const setAddCustomHeaders = useCallback((value: boolean): void => {
    dispatch(setEditAddCustomHeaders(value))
  }, [dispatch])

  const setCustomHeaders = useCallback((value: EditToolFormState["customHeaders"]): void => {
    dispatch(setEditCustomHeaders(value))
  }, [dispatch])

  const setAddForwardedHeaders = useCallback((value: boolean): void => {
    dispatch(setEditAddForwardedHeaders(value))
  }, [dispatch])

  const setForwardedHeaders = useCallback((value: string[]): void => {
    dispatch(setEditForwardedHeaders(value))
  }, [dispatch])

  const setApplyRateLimiting = useCallback((value: boolean): void => {
    dispatch(setEditApplyRateLimiting(value))
  }, [dispatch])

  const setCallsPerMinute = useCallback((value: string): void => {
    dispatch(setEditCallsPerMinute(value))
  }, [dispatch])

  const setSubmitted = useCallback((value: boolean): void => {
    dispatch(setEditSubmitted(value))
  }, [dispatch])

  return {
    ...formState,
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
  }
}

export { useEditToolFormState }
