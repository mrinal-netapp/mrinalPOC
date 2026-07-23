import { configureStore } from "@reduxjs/toolkit"
import { vi } from "vitest"

import { agentApi } from "../../api/agent-api.slice"
import { apiSlice } from "../../api/api.slice"
import "../../api/project-api.slice"
import { utilitiesApi } from "../../api/utilities-api.slice"
import { TOOLSET_STORE_SLICE_NAME } from "../../components/toolset/model"
import { toolsetReducer } from "../../components/toolset/reducer"
import { layoutSlice } from "../../store/slices/layout.slice"
import { dataSourceSlice } from "../../store/slices/data-source.slice"
import { datasetSlice } from "../../store/slices/dataset.slice"
import { evalSlice } from "../../store/slices/eval.slice"
import { kbSlice } from "../../store/slices/kb.slice"
import { modelSlice } from "../../store/slices/model.slice"
import { projectContextSlice, setActiveProject } from "../../store/slices/project-context.slice"
// agentsConfigApi and agentsRuntimeApi inject into apiSlice — importing for
// the side-effect registers their endpoints, mirroring the production store.
import "../../routes/pages/agents/api/agents-config-api.slice"
import "../../routes/pages/agents/api/agents-runtime-api.slice"
import { agentsSlice } from "../../store/agents"
import { agentPlaygroundSlice } from "../../store/agent-playground"
import { store } from "../../store/store"
import type { RootState } from "../../store/store.types"

/**
 * Creates a Redux store that mirrors the production store structure.
 *
 * RTK Query middleware is required to enable caching, invalidation, and
 * subscription lifecycle — keeping it in the mock store ensures components
 * that rely on API hooks behave correctly under test.
 */
export function createMockStore(preloadedState?: Partial<RootState>) {
  const testStore = configureStore({
    reducer: {
      [agentApi.reducerPath]: agentApi.reducer,
      [apiSlice.reducerPath]: apiSlice.reducer,
      [utilitiesApi.reducerPath]: utilitiesApi.reducer,
      [layoutSlice.name]: layoutSlice.reducer,
      [dataSourceSlice.name]: dataSourceSlice.reducer,
      [datasetSlice.name]: datasetSlice.reducer,
      [evalSlice.name]: evalSlice.reducer,
      [kbSlice.name]: kbSlice.reducer,
      [modelSlice.name]: modelSlice.reducer,
      [projectContextSlice.name]: projectContextSlice.reducer,
      [agentsSlice.name]: agentsSlice.reducer,
      [agentPlaygroundSlice.name]: agentPlaygroundSlice.reducer,
      [TOOLSET_STORE_SLICE_NAME]: toolsetReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().concat(
        apiSlice.middleware,
        agentApi.middleware,
        utilitiesApi.middleware,
      ),
  }) as typeof store

  const projectContext = preloadedState?.projectContext
  if (projectContext?.activeProject?.id) {
    testStore.dispatch(setActiveProject({
      id: projectContext.activeProject.id,
      name: projectContext.activeProject.name ?? "",
      role: projectContext.activeProject.role ?? null,
    }))
  }

  return testStore
}

type ROCallback = (entries: ResizeObserverEntry[], observer: ResizeObserver) => void

export interface ResizeObserverHandle {
  capturedCallback: ROCallback | null
  cleanup: () => void
}

/*
 * jsdom does not implement ResizeObserver. Call this in beforeEach for any test
 * suite that renders components using ResizeObserver (e.g. ChipList,
 * SelectDropdown chip-display mode).
 *
 * The returned handle exposes `capturedCallback` — the callback passed by the
 * component to `new ResizeObserver(cb)` — so tests can trigger resize logic
 * manually via `act(() => handle.capturedCallback!([], {} as ResizeObserver))`.
 * Call `handle.cleanup()` in afterEach to restore the original global.
 */
export function mockResizeObserver(): ResizeObserverHandle {
  const original = window.ResizeObserver

  const handle: ResizeObserverHandle = {
    capturedCallback: null,
    cleanup: () => {
      window.ResizeObserver = original
    },
  }

  class MockRO {
    constructor(callback: ROCallback) {
      handle.capturedCallback = callback
    }

    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
  }

  window.ResizeObserver = MockRO as unknown as typeof ResizeObserver

  return handle
}
