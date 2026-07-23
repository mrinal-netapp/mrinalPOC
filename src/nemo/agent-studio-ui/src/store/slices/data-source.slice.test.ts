import { describe, expect, it } from "vitest"

import {
  dataSourceSlice,
  setSelectedDataSource,
  setDataSourceFilters,
  resetDataSourceFilters,
} from "./data-source.slice"

const reducer = dataSourceSlice.reducer

describe("dataSourceSlice", () => {
  // -- 2.1 Initial state
  it("[tag:data-source][tag:redux] should return the correct initial state", () => {
    const state = reducer(undefined, { type: "@@INIT" })

    expect(state).toEqual({ selectedDsrcId: null, listFilters: {} })
  })

  // -- 2.2 setSelectedDataSource — string ID
  it("[tag:data-source][tag:redux] should set selectedDsrcId to the provided string", () => {
    const state = reducer(undefined, setSelectedDataSource("abc-123"))

    expect(state.selectedDsrcId).toBe("abc-123")
  })

  // -- 2.3 setSelectedDataSource — reset to null
  it("[tag:data-source][tag:redux] should reset selectedDsrcId to null", () => {
    const prev = reducer(undefined, setSelectedDataSource("abc-123"))
    const state = reducer(prev, setSelectedDataSource(null))

    expect(state.selectedDsrcId).toBeNull()
  })

  // -- 2.4 setDataSourceFilters — merge into empty
  it("[tag:data-source][tag:redux] should merge filters into empty listFilters", () => {
    const state = reducer(undefined, setDataSourceFilters({ limit: 10, offset: 0 }))

    expect(state.listFilters).toEqual({ limit: 10, offset: 0 })
  })

  // -- 2.5 setDataSourceFilters — merge additional
  it("[tag:data-source][tag:redux] should merge additional filters into existing ones", () => {
    const prev = reducer(undefined, setDataSourceFilters({ limit: 10 }))
    const state = reducer(prev, setDataSourceFilters({ search: "foo" }))

    expect(state.listFilters).toEqual({ limit: 10, search: "foo" })
  })

  // -- 2.6 setDataSourceFilters — overwrite field
  it("[tag:data-source][tag:redux] should overwrite an existing filter field", () => {
    const prev = reducer(undefined, setDataSourceFilters({ limit: 10 }))
    const state = reducer(prev, setDataSourceFilters({ limit: 20 }))

    expect(state.listFilters.limit).toBe(20)
  })

  // -- 2.7 resetDataSourceFilters
  it("[tag:data-source][tag:redux] should clear all filters back to empty object", () => {
    const prev = reducer(
      undefined,
      setDataSourceFilters({ limit: 10, search: "bar", sort_by: "name" }),
    )
    const state = reducer(prev, resetDataSourceFilters())

    expect(state.listFilters).toEqual({})
  })
})
