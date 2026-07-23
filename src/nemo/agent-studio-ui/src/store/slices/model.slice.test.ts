import { describe, expect, it } from "vitest"

import {
  modelSlice,
  setSelectedModel,
  setModelFilters,
  resetModelFilters,
} from "./model.slice"

const reducer = modelSlice.reducer

describe("modelSlice", () => {
  it("[tag:model][tag:redux] should return the correct initial state", () => {
    const state = reducer(undefined, { type: "@@INIT" })

    expect(state).toEqual({ selectedModelId: null, listFilters: {} })
  })

  it("[tag:model][tag:redux] should set selectedModelId to the provided string", () => {
    const state = reducer(undefined, setSelectedModel("gpt-4o"))

    expect(state.selectedModelId).toBe("gpt-4o")
  })

  it("[tag:model][tag:redux] should reset selectedModelId to null", () => {
    const prev = reducer(undefined, setSelectedModel("gpt-4o"))
    const state = reducer(prev, setSelectedModel(null))

    expect(state.selectedModelId).toBeNull()
  })

  it("[tag:model][tag:redux] should merge filters into empty listFilters", () => {
    const state = reducer(undefined, setModelFilters({ limit: 10, offset: 0 }))

    expect(state.listFilters).toEqual({ limit: 10, offset: 0 })
  })

  it("[tag:model][tag:redux] should merge additional filters into existing ones", () => {
    const prev = reducer(undefined, setModelFilters({ limit: 10 }))
    const state = reducer(prev, setModelFilters({ search: "foo" }))

    expect(state.listFilters).toEqual({ limit: 10, search: "foo" })
  })

  it("[tag:model][tag:redux] should overwrite an existing filter field", () => {
    const prev = reducer(undefined, setModelFilters({ limit: 10 }))
    const state = reducer(prev, setModelFilters({ limit: 20 }))

    expect(state.listFilters.limit).toBe(20)
  })

  it("[tag:model][tag:redux] should clear all filters back to empty object", () => {
    const prev = reducer(undefined, setModelFilters({ limit: 10, search: "bar" }))
    const state = reducer(prev, resetModelFilters())

    expect(state.listFilters).toEqual({})
  })
})
