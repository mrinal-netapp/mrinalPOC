import { renderHook, act } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { useRowExpansion } from "./useRowExpansion"

describe("useRowExpansion", () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it("initializes with no expanded rows by default", () => {
    const { result } = renderHook(() => useRowExpansion())
    expect(result.current.isExpanded("row-1")).toBe(false)
    expect(result.current.isRowVisible("row-1")).toBe(false)
    expect(result.current.isClosing("row-1")).toBe(false)
  })

  it("initializes with provided ids expanded", () => {
    const { result } = renderHook(() => useRowExpansion(["a", "b"]))
    expect(result.current.isExpanded("a")).toBe(true)
    expect(result.current.isExpanded("b")).toBe(true)
    expect(result.current.isExpanded("c")).toBe(false)
  })

  it("toggles a row from collapsed to expanded", () => {
    const { result } = renderHook(() => useRowExpansion())
    act(() => result.current.toggleExpanded("row-1"))
    expect(result.current.isExpanded("row-1")).toBe(true)
    expect(result.current.isRowVisible("row-1")).toBe(true)
    expect(result.current.isClosing("row-1")).toBe(false)
  })

  it("toggles a row from expanded to closing, then fully removed after 300ms", () => {
    const { result } = renderHook(() => useRowExpansion(["row-1"]))

    act(() => result.current.toggleExpanded("row-1"))

    expect(result.current.isExpanded("row-1")).toBe(false)
    expect(result.current.isClosing("row-1")).toBe(true)
    expect(result.current.isRowVisible("row-1")).toBe(true)

    act(() => { vi.advanceTimersByTime(300) })

    expect(result.current.isClosing("row-1")).toBe(false)
    expect(result.current.isRowVisible("row-1")).toBe(false)
  })

  it("re-expanding during close cancels the animation", () => {
    const { result } = renderHook(() => useRowExpansion(["row-1"]))

    act(() => result.current.toggleExpanded("row-1"))
    expect(result.current.isClosing("row-1")).toBe(true)

    act(() => result.current.toggleExpanded("row-1"))
    expect(result.current.isExpanded("row-1")).toBe(true)
    expect(result.current.isClosing("row-1")).toBe(false)

    act(() => { vi.advanceTimersByTime(300) })
    expect(result.current.isExpanded("row-1")).toBe(true)
    expect(result.current.isRowVisible("row-1")).toBe(true)
  })

  it("expandAll sets all provided ids as expanded", () => {
    const { result } = renderHook(() => useRowExpansion())
    act(() => result.current.expandAll(["a", "b", "c"]))
    expect(result.current.isExpanded("a")).toBe(true)
    expect(result.current.isExpanded("b")).toBe(true)
    expect(result.current.isExpanded("c")).toBe(true)
  })

  it("collapseAll clears all expanded ids and pending close timers", () => {
    const { result } = renderHook(() => useRowExpansion(["a", "b"]))

    // Collapse "a" to create a pending close timer
    act(() => result.current.toggleExpanded("a"))
    expect(result.current.isClosing("a")).toBe(true)

    // collapseAll should clear everything including the pending timer
    act(() => result.current.collapseAll())
    expect(result.current.isExpanded("a")).toBe(false)
    expect(result.current.isExpanded("b")).toBe(false)
    expect(result.current.isClosing("a")).toBe(false)
  })

  it("cleans up pending close timers on unmount", () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout")
    const { result, unmount } = renderHook(() => useRowExpansion(["row-1"]))

    // Start a collapse (creates a pending timer)
    act(() => result.current.toggleExpanded("row-1"))
    expect(result.current.isClosing("row-1")).toBe(true)

    // Unmount before the timer fires — cleanup should clear it
    const countBefore = clearTimeoutSpy.mock.calls.length
    unmount()
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(countBefore)

    clearTimeoutSpy.mockRestore()
  })

  it("handles multiple rows independently", () => {
    const { result } = renderHook(() => useRowExpansion())

    act(() => result.current.toggleExpanded("a"))
    act(() => result.current.toggleExpanded("b"))

    expect(result.current.isExpanded("a")).toBe(true)
    expect(result.current.isExpanded("b")).toBe(true)

    act(() => result.current.toggleExpanded("a"))
    expect(result.current.isExpanded("a")).toBe(false)
    expect(result.current.isClosing("a")).toBe(true)
    expect(result.current.isExpanded("b")).toBe(true)
  })
})
