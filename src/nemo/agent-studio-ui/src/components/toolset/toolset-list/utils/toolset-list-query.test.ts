import { renderHook } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { Provider } from "react-redux"
import { describe, expect, it } from "vitest"

import { createMockStore } from "@test/mocks"
import { useToolsetListQuery } from "./toolset-list-query"

const Wrapper = ({ children }: { children: ReactNode }) =>
  createElement(Provider, { store: createMockStore(), children })

describe("useToolsetListQuery", () => {
  it("[tag:toolset-list-query] reads list state from redux", () => {
    const { result } = renderHook(() => useToolsetListQuery(), { wrapper: Wrapper })

    expect(result.current.data?.data).toEqual([])
    expect(result.current.isLoading).toBe(false)
    expect(result.current.isError).toBe(false)
  })
})
