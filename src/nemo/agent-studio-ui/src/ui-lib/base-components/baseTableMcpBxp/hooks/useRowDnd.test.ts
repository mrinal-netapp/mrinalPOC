import { renderHook, act } from "@testing-library/react"
import { describe, it, expect, vi, afterEach } from "vitest"
import { useRowDnd } from "./useRowDnd"

vi.mock("@/utils/drag-ghost", () => ({
  createElementGhost: vi.fn(() => document.createElement("div")),
  clearDragGhost: vi.fn(),
}))

import { createElementGhost, clearDragGhost } from "@/utils/drag-ghost"

type Row = { id: string; name: string }

const rows: Row[] = [
  { id: "r1", name: "Row 1" },
  { id: "r2", name: "Row 2" },
  { id: "r3", name: "Row 3" },
]

function makeDragEvent(overrides: Record<string, unknown> = {}): React.DragEvent {
  const dataStore: Record<string, string> = {}
  const currentTarget = document.createElement("tr")
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

describe("useRowDnd", () => {
  it("onDragStart sets dataTransfer and creates element ghost when enabled", () => {
    const { result } = renderHook(() =>
      useRowDnd({ enabled: true, rows, setRows: vi.fn() }),
    )
    const e = makeDragEvent()
    act(() => result.current.onDragStart(e, "r1"))
    expect(e.dataTransfer.getData("text/plain")).toBe("r1")
    expect(e.dataTransfer.effectAllowed).toBe("move")
    expect(createElementGhost).toHaveBeenCalledWith(e.currentTarget)
  })

  it("onDragStart does nothing when disabled", () => {
    const { result } = renderHook(() =>
      useRowDnd({ enabled: false, rows, setRows: vi.fn() }),
    )
    const e = makeDragEvent()
    act(() => result.current.onDragStart(e, "r1"))
    expect(createElementGhost).not.toHaveBeenCalled()
  })

  it("onDragOver sets dragOverId and prevents default", () => {
    const { result } = renderHook(() =>
      useRowDnd({ enabled: true, rows, setRows: vi.fn() }),
    )
    const e = makeDragEvent()
    act(() => result.current.onDragOver(e, "r2"))
    expect(result.current.dragOverId).toBe("r2")
    expect(e.preventDefault).toHaveBeenCalled()
  })

  it("onDragOver does nothing when disabled", () => {
    const { result } = renderHook(() =>
      useRowDnd({ enabled: false, rows, setRows: vi.fn() }),
    )
    const e = makeDragEvent()
    act(() => result.current.onDragOver(e, "r2"))
    expect(result.current.dragOverId).toBeNull()
  })

  it("onDrop reorders rows", () => {
    const setRows = vi.fn()
    const { result } = renderHook(() =>
      useRowDnd({ enabled: true, rows, setRows }),
    )
    const e = makeDragEvent()
    e.dataTransfer.setData("text/plain", "r1")
    act(() => result.current.onDrop(e, "r3"))

    expect(setRows).toHaveBeenCalledTimes(1)
    const updater = setRows.mock.calls[0][0] as (prev: Row[]) => Row[]
    const reordered = updater(rows)
    expect(reordered.map((r) => r.id)).toEqual(["r2", "r3", "r1"])
  })

  it("onDrop does nothing when source equals target", () => {
    const setRows = vi.fn()
    const { result } = renderHook(() =>
      useRowDnd({ enabled: true, rows, setRows }),
    )
    const e = makeDragEvent()
    e.dataTransfer.setData("text/plain", "r1")
    act(() => result.current.onDrop(e, "r1"))
    expect(setRows).not.toHaveBeenCalled()
  })

  it("onDrop does nothing when disabled", () => {
    const setRows = vi.fn()
    const { result } = renderHook(() =>
      useRowDnd({ enabled: false, rows, setRows }),
    )
    const e = makeDragEvent()
    e.dataTransfer.setData("text/plain", "r1")
    act(() => result.current.onDrop(e, "r2"))
    expect(setRows).not.toHaveBeenCalled()
  })

  it("onDrop does nothing when source row is not found", () => {
    const setRows = vi.fn()
    const { result } = renderHook(() =>
      useRowDnd({ enabled: true, rows, setRows }),
    )
    const e = makeDragEvent()
    e.dataTransfer.setData("text/plain", "unknown-id")
    act(() => result.current.onDrop(e, "r1"))
    expect(setRows).not.toHaveBeenCalled()
  })

  it("onDragEnd clears dragOverId and ghost", () => {
    const { result } = renderHook(() =>
      useRowDnd({ enabled: true, rows, setRows: vi.fn() }),
    )
    const e = makeDragEvent()
    act(() => result.current.onDragOver(e, "r2"))
    expect(result.current.dragOverId).toBe("r2")

    act(() => result.current.onDragEnd())
    expect(result.current.dragOverId).toBeNull()
    expect(clearDragGhost).toHaveBeenCalled()
  })

  it("uses custom dataTransferKey when provided", () => {
    const setRows = vi.fn()
    const { result } = renderHook(() =>
      useRowDnd({ enabled: true, rows, setRows, dataTransferKey: "text/row-id" }),
    )
    const e = makeDragEvent()
    act(() => result.current.onDragStart(e, "r1"))
    expect(e.dataTransfer.getData("text/row-id")).toBe("r1")

    e.dataTransfer.setData("text/row-id", "r1")
    act(() => result.current.onDrop(e, "r3"))
    expect(setRows).toHaveBeenCalled()
  })
})
