import { describe, expect, it } from "vitest"

import { createMockStore } from "@test/mocks"

import { initializeAddToolForm, initializeEditToolForm, loadToolsetDetail } from "./actions"
import { toolsetSelector } from "./selectors"

describe("toolset actions", () => {
  it("[tag:toolset][tag:redux] initializeAddToolForm resets add-tool state to defaults", () => {
    const store = createMockStore()
    store.dispatch(initializeAddToolForm())

    const form = toolsetSelector.addToolFormState(store.getState())
    expect(form.name).toBe("")
    expect(form.description).toBe("")
    expect(form.activeTabId).toBe("custom")
    expect(form.selectedLabels).toEqual([])
  })

  it("[tag:toolset][tag:redux] initializeEditToolForm sets tool id in edit form state", () => {
    const store = createMockStore()
    store.dispatch(initializeEditToolForm("tool-123"))

    const form = toolsetSelector.editToolFormState(store.getState())
    expect(form.toolId).toBe("tool-123")
    expect(form.name).toBe("")
  })

  it("[tag:toolset][tag:redux] loadToolsetDetail resets detail, stores tool id, and sets loading", () => {
    const store = createMockStore()
    store.dispatch(loadToolsetDetail("tool-456"))

    const detail = toolsetSelector.detail(store.getState())
    expect(detail.toolId).toBe("tool-456")
    expect(detail.tool).toBeNull()
    expect(detail.isLoading).toBe(true)
    expect(detail.isError).toBe(false)
  })
})
