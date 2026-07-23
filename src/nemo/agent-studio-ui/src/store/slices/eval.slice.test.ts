import { describe, expect, it } from "vitest"

import {
  evalSlice,
  setSelectedTemplate,
  setEvalFilters,
  resetEvalFilters,
} from "./eval.slice"

const reducer = evalSlice.reducer

describe("evalSlice", () => {
  // -- Initial state
  it("[tag:eval][tag:redux] should return the correct initial state", () => {
    const state = reducer(undefined, { type: "@@INIT" })

    expect(state).toEqual({ selectedTemplateId: null, listFilters: {} })
  })

  // -- setSelectedTemplate — string ID
  it("[tag:eval][tag:redux] should set selectedTemplateId to the provided string", () => {
    const state = reducer(undefined, setSelectedTemplate("evt-abc"))

    expect(state.selectedTemplateId).toBe("evt-abc")
  })

  // -- setSelectedTemplate — reset to null
  it("[tag:eval][tag:redux] should reset selectedTemplateId to null", () => {
    const prev = reducer(undefined, setSelectedTemplate("evt-abc"))
    const state = reducer(prev, setSelectedTemplate(null))

    expect(state.selectedTemplateId).toBeNull()
  })

  // -- setEvalFilters — merge into empty
  it("[tag:eval][tag:redux] should merge filters into empty listFilters", () => {
    const state = reducer(undefined, setEvalFilters({ limit: 10, offset: 0 }))

    expect(state.listFilters).toEqual({ limit: 10, offset: 0 })
  })

  // -- setEvalFilters — merge additional
  it("[tag:eval][tag:redux] should merge additional filters into existing ones", () => {
    const prev = reducer(undefined, setEvalFilters({ limit: 10 }))
    const state = reducer(prev, setEvalFilters({ suite: "rag" }))

    expect(state.listFilters).toEqual({ limit: 10, suite: "rag" })
  })

  // -- setEvalFilters — overwrite field
  it("[tag:eval][tag:redux] should overwrite an existing filter field", () => {
    const prev = reducer(undefined, setEvalFilters({ limit: 10 }))
    const state = reducer(prev, setEvalFilters({ limit: 20 }))

    expect(state.listFilters.limit).toBe(20)
  })

  // -- resetEvalFilters
  it("[tag:eval][tag:redux] should clear all filters back to empty object", () => {
    const prev = reducer(undefined, setEvalFilters({ limit: 10, status: "completed" }))
    const state = reducer(prev, resetEvalFilters())

    expect(state.listFilters).toEqual({})
  })
})
