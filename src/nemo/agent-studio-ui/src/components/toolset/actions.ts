import type { AppDispatch } from "@/store/store.types"

import {
  resetAddToolState,
  resetDetailState,
  resetEditToolState,
  setDetailLoading,
  setDetailToolId,
  setEditToolId,
} from "./reducer"

export const initializeAddToolForm = () => (dispatch: AppDispatch): void => {
  dispatch(resetAddToolState())
}

export const initializeEditToolForm = (toolId: string) => (dispatch: AppDispatch): void => {
  dispatch(resetEditToolState())
  dispatch(setEditToolId(toolId))
}

/** Resets detail slice and marks loading until a follow-up sets detail data or error. */
export const loadToolsetDetail =
  (toolId: string) =>
  (dispatch: AppDispatch): void => {
    dispatch(resetDetailState())
    dispatch(setDetailToolId(toolId))
    dispatch(setDetailLoading(true))
  }
