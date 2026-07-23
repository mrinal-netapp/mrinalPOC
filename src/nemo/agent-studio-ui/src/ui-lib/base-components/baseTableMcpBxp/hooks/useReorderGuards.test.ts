import { describe, it, expect } from "vitest"
import { useReorderGuards } from "./useReorderGuards"

describe("useReorderGuards", () => {
  it("allows row drag when no sorting/filtering and option enabled", () => {
    const { allowRowDrag, canReorderRows } = useReorderGuards({
      sorting: [],
      columnFilters: [],
      options: { enableRowDrag: true },
    })
    expect(allowRowDrag).toBe(true)
    expect(canReorderRows).toBe(true)
  })

  it("disables row drag when sorting is active", () => {
    const { allowRowDrag, canReorderRows } = useReorderGuards({
      sorting: [{ id: "col1", desc: false }],
      columnFilters: [],
      options: { enableRowDrag: true },
    })
    expect(allowRowDrag).toBe(false)
    expect(canReorderRows).toBe(false)
  })

  it("disables row drag when column filters are active", () => {
    const { allowRowDrag, canReorderRows } = useReorderGuards({
      sorting: [],
      columnFilters: [{ id: "col1", value: "test" }],
      options: { enableRowDrag: true },
    })
    expect(allowRowDrag).toBe(false)
    expect(canReorderRows).toBe(false)
  })

  it("disables row drag when option is off even with no sorting/filtering", () => {
    const { allowRowDrag, canReorderRows } = useReorderGuards({
      sorting: [],
      columnFilters: [],
      options: { enableRowDrag: false },
    })
    expect(allowRowDrag).toBe(false)
    expect(canReorderRows).toBe(true)
  })

  it("always allows column drag when option is enabled regardless of sorting/filtering", () => {
    const { allowColumnDrag } = useReorderGuards({
      sorting: [{ id: "col1", desc: true }],
      columnFilters: [{ id: "col1", value: "test" }],
      options: { enableColumnDrag: true, enableRowDrag: true },
    })
    expect(allowColumnDrag).toBe(true)
  })

  it("disables column drag when option is off", () => {
    const { allowColumnDrag } = useReorderGuards({
      sorting: [],
      columnFilters: [],
      options: { enableColumnDrag: false },
    })
    expect(allowColumnDrag).toBe(false)
  })

  it("handles undefined options gracefully", () => {
    const { allowRowDrag, allowColumnDrag } = useReorderGuards({
      sorting: [],
      columnFilters: [],
      options: {},
    })
    expect(allowRowDrag).toBe(false)
    expect(allowColumnDrag).toBe(false)
  })
})
