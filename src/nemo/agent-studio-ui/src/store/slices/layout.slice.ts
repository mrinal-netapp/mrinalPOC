import { createSlice, type PayloadAction } from "@reduxjs/toolkit"
import type { LayoutState } from "../store.types"

const SLICE_NAME = 'layout';

const initialState: LayoutState = {
  isSidebarOpen: true,
}

export const layoutSlice = createSlice({
  name: SLICE_NAME,
  initialState,
  reducers: {
    toggleSidebar(state) {
      state.isSidebarOpen = !state.isSidebarOpen
    },
    setSidebarOpen(state, action: PayloadAction<boolean>) {
      state.isSidebarOpen = action.payload
    },
  },
})

export const { toggleSidebar, setSidebarOpen } = layoutSlice.actions

export default layoutSlice;
