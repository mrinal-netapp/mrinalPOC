import { renderHook, act } from "@testing-library/react"
import { describe, it, expect, vi, afterEach } from "vitest"
import { useColumnDnd } from "./useColumnDnd"

vi.mock("@/utils/drag-ghost", () => ({
  createElementGhost: vi.fn(() => document.createElement("div")),
  clearDragGhost: vi.fn(),
}))

import { createElementGhost, clearDragGhost } from "@/utils/drag-ghost"

function mockTable(columnIds: string[] = ["a", "b", "c"]) {
  return {
    getAllLeafColumns: () => columnIds.map((id) => ({ id })),
  } as never
}

function makeDragEvent(overrides: Record<string, unknown> = {}): React.DragEvent {
  const dataStore: Record<string, string> = {}
  const currentTarget = document.createElement("th")
  return {
    currentTarget,
    dataTransfer: {
      setData: (key: string, val: string) => { dataStore[key] = val },
      getData: (key: string) => dataStore[key] ?? "",
      setDragImage: vi.fn(),
      effectAllowed: "",
    },
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as React.DragEvent
}

afterEach(() => {
  vi.clearAllMocks()
})

describe("useColumnDnd", () => {
  it("isHeaderDraggable returns false when disabled", () => {
    const { result } = renderHook(() =>
      useColumnDnd({ enabled: false, columnOrder: [], setColumnOrder: vi.fn(), table: mockTable() }),
    )
    expect(result.current.isHeaderDraggable("a")).toBe(false)
  })

  it("isHeaderDraggable returns true when enabled", () => {
    const { result } = renderHook(() =>
      useColumnDnd({ enabled: true, columnOrder: [], setColumnOrder: vi.fn(), table: mockTable() }),
    )
    expect(result.current.isHeaderDraggable("a")).toBe(true)
  })

  it("isHeaderDraggable returns false when the column is being resized", () => {
    const { result } = renderHook(() =>
      useColumnDnd({
        enabled: true,
        columnOrder: [],
        setColumnOrder: vi.fn(),
        table: mockTable(),
        columnSizingInfo: { isResizingColumn: "b" } as never,
      }),
    )
    expect(result.current.isHeaderDraggable("b")).toBe(false)
    expect(result.current.isHeaderDraggable("a")).toBe(true)
  })

  it("onDragStart sets dataTransfer data and creates element ghost", () => {
    const { result } = renderHook(() =>
      useColumnDnd({ enabled: true, columnOrder: [], setColumnOrder: vi.fn(), table: mockTable() }),
    )
    const e = makeDragEvent()
    act(() => result.current.onDragStart(e, "b"))
    expect(e.dataTransfer.getData("text/column-id")).toBe("b")
    expect(e.dataTransfer.effectAllowed).toBe("move")
    expect(createElementGhost).toHaveBeenCalledWith(e.currentTarget)
  })

  it("onDragStart does nothing when column is not draggable", () => {
    const { result } = renderHook(() =>
      useColumnDnd({ enabled: false, columnOrder: [], setColumnOrder: vi.fn(), table: mockTable() }),
    )
    const e = makeDragEvent()
    act(() => result.current.onDragStart(e, "a"))
    expect(createElementGhost).not.toHaveBeenCalled()
  })

  it("onDragOver sets dragOverColumnId", () => {
    const { result } = renderHook(() =>
      useColumnDnd({ enabled: true, columnOrder: [], setColumnOrder: vi.fn(), table: mockTable() }),
    )
    const e = makeDragEvent()
    act(() => result.current.onDragOver(e, "c"))
    expect(result.current.dragOverColumnId).toBe("c")
    expect(e.preventDefault).toHaveBeenCalled()
  })

  it("onDragOver does nothing when disabled", () => {
    const { result } = renderHook(() =>
      useColumnDnd({ enabled: false, columnOrder: [], setColumnOrder: vi.fn(), table: mockTable() }),
    )
    const e = makeDragEvent()
    act(() => result.current.onDragOver(e, "c"))
    expect(result.current.dragOverColumnId).toBeNull()
  })

  it("onDrop reorders columns using columnOrder state", () => {
    const setColumnOrder = vi.fn()
    const { result } = renderHook(() =>
      useColumnDnd({
        enabled: true,
        columnOrder: ["a", "b", "c"],
        setColumnOrder,
        table: mockTable(),
      }),
    )
    const e = makeDragEvent()
    e.dataTransfer.setData("text/column-id", "a")
    act(() => result.current.onDrop(e, "c"))
    expect(setColumnOrder).toHaveBeenCalledWith(["b", "c", "a"])
  })

  it("onDrop derives order from table columns when columnOrder is empty", () => {
    const setColumnOrder = vi.fn()
    const { result } = renderHook(() =>
      useColumnDnd({
        enabled: true,
        columnOrder: [],
        setColumnOrder,
        table: mockTable(["x", "y", "z"]),
      }),
    )
    const e = makeDragEvent()
    e.dataTransfer.setData("text/column-id", "z")
    act(() => result.current.onDrop(e, "x"))
    expect(setColumnOrder).toHaveBeenCalledWith(["z", "x", "y"])
  })

  it("onDrop does nothing when source equals target", () => {
    const setColumnOrder = vi.fn()
    const { result } = renderHook(() =>
      useColumnDnd({
        enabled: true,
        columnOrder: ["a", "b"],
        setColumnOrder,
        table: mockTable(),
      }),
    )
    const e = makeDragEvent()
    e.dataTransfer.setData("text/column-id", "a")
    act(() => result.current.onDrop(e, "a"))
    expect(setColumnOrder).not.toHaveBeenCalled()
  })

  it("onDrop does nothing when disabled", () => {
    const setColumnOrder = vi.fn()
    const { result } = renderHook(() =>
      useColumnDnd({
        enabled: false,
        columnOrder: ["a", "b"],
        setColumnOrder,
        table: mockTable(),
      }),
    )
    const e = makeDragEvent()
    e.dataTransfer.setData("text/column-id", "a")
    act(() => result.current.onDrop(e, "b"))
    expect(setColumnOrder).not.toHaveBeenCalled()
  })

  it("onDrop does nothing when source column is not found in order", () => {
    const setColumnOrder = vi.fn()
    const { result } = renderHook(() =>
      useColumnDnd({
        enabled: true,
        columnOrder: ["a", "b"],
        setColumnOrder,
        table: mockTable(),
      }),
    )
    const e = makeDragEvent()
    e.dataTransfer.setData("text/column-id", "unknown")
    act(() => result.current.onDrop(e, "a"))
    expect(setColumnOrder).not.toHaveBeenCalled()
  })

  it("onDragEnd clears dragOverColumnId and ghost", () => {
    const { result } = renderHook(() =>
      useColumnDnd({ enabled: true, columnOrder: [], setColumnOrder: vi.fn(), table: mockTable() }),
    )
    const e = makeDragEvent()
    act(() => result.current.onDragOver(e, "b"))
    expect(result.current.dragOverColumnId).toBe("b")

    act(() => result.current.onDragEnd())
    expect(result.current.dragOverColumnId).toBeNull()
    expect(clearDragGhost).toHaveBeenCalled()
  })
})
