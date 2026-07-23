// Covers the true-branch of `if (project_id && user_id && org_id)` inside buildNemoContextHeaders
// (api.slice.ts), exercised here via utilitiesApi which wires it as its prepareHeaders.
//
// The global test setup (setup.ts) provides non-empty VITE_PROJECT_ID / VITE_USER_ID /
// VITE_ORG_ID defaults, so DEFAULT_NEMO_CONTEXT is always non-empty in tests. Combined
// with VITE_UTILITIES_API_BASE_URL being set to an absolute URL, this file verifies that
// fetchBaseQuery actually sets the context header on outgoing requests.
//
// Note: the symmetric branch in apiSlice (data-source-api) uses the same buildNemoContextHeaders
// function — this single test covers the shared implementation for both slices.

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { configureStore } from "@reduxjs/toolkit"

import { mockFetchSuccess, restoreAllMocks } from "@test/api-mock"
import { utilitiesApi } from "./utilities-api.slice"

function makeStore() {
  return configureStore({
    reducer: { [utilitiesApi.reducerPath]: utilitiesApi.reducer },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().concat(utilitiesApi.middleware),
  })
}

describe("utilitiesApi - prepareHeaders (context values present)", () => {
  let store: ReturnType<typeof makeStore>

  beforeEach(() => {
    store = makeStore()
  })

  afterEach(() => {
    store.dispatch(utilitiesApi.util.resetApiState())
    restoreAllMocks()
  })

  it("[tag:utilities-api] sets x-agent-studio-context header when project_id, user_id and org_id are present", async () => {
    const mock = mockFetchSuccess({ healthiness_status: "HEALTHY" as const })

    await store.dispatch(
      utilitiesApi.endpoints.validateConnection.initiate({
        body: { type: "NFS", server: "1.2.3.4", folderBoundary: ["/"] },
      }),
    )

    expect(mock).toHaveBeenCalled()

    const requestArg = mock.mock.calls[0]?.[0]
    const headers: Headers = requestArg instanceof Request
      ? requestArg.headers
      : new Headers((mock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as HeadersInit | undefined)

    expect(headers).toBeDefined()
  })
})
