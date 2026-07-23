import { describe, expect, it } from "vitest"

import {
  datasetSlice,
  setSelectedDataset,
  setDatasetFilters,
  resetDatasetFilters,
} from "./dataset.slice"

const reducer = datasetSlice.reducer

describe("datasetSlice", () => {
  // -- Initial state
  it("[tag:dataset][tag:redux] should return the correct initial state", () => {
    const state = reducer(undefined, { type: "@@INIT" })

    expect(state).toEqual({ selectedDsetId: null, listFilters: {} })
  })

  // -- setSelectedDataset — string ID
  it("[tag:dataset][tag:redux] should set selectedDsetId to the provided string", () => {
    const state = reducer(undefined, setSelectedDataset("dset-abc"))

    expect(state.selectedDsetId).toBe("dset-abc")
  })

  // -- setSelectedDataset — reset to null
  it("[tag:dataset][tag:redux] should reset selectedDsetId to null", () => {
    const prev = reducer(undefined, setSelectedDataset("dset-abc"))
    const state = reducer(prev, setSelectedDataset(null))

    expect(state.selectedDsetId).toBeNull()
  })

  // -- setDatasetFilters — merge into empty
  it("[tag:dataset][tag:redux] should merge filters into empty listFilters", () => {
    const state = reducer(undefined, setDatasetFilters({ limit: 10, offset: 0 }))

    expect(state.listFilters).toEqual({ limit: 10, offset: 0 })
  })

  // -- setDatasetFilters — merge additional
  it("[tag:dataset][tag:redux] should merge additional filters into existing ones", () => {
    const prev = reducer(undefined, setDatasetFilters({ limit: 10 }))
    const state = reducer(prev, setDatasetFilters({ search: "foo" }))

    expect(state.listFilters).toEqual({ limit: 10, search: "foo" })
  })

  // -- setDatasetFilters — overwrite field
  it("[tag:dataset][tag:redux] should overwrite an existing filter field", () => {
    const prev = reducer(undefined, setDatasetFilters({ limit: 10 }))
    const state = reducer(prev, setDatasetFilters({ limit: 20 }))

    expect(state.listFilters.limit).toBe(20)
  })

  // -- resetDatasetFilters
  it("[tag:dataset][tag:redux] should clear all filters back to empty object", () => {
    const prev = reducer(
      undefined,
      setDatasetFilters({ limit: 10, search: "bar" }),
    )
    const state = reducer(prev, resetDatasetFilters())

    expect(state.listFilters).toEqual({})
  })
})
