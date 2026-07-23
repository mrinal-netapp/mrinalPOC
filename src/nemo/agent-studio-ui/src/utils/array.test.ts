import { describe, it, expect } from "vitest"
import { arrayMove } from "./array"

describe("arrayMove", () => {
  it("moves an item forward in the array", () => {
    expect(arrayMove(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"])
  })

  it("moves an item backward in the array", () => {
    expect(arrayMove(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"])
  })

  it("returns an identical array when from and to are the same", () => {
    const arr = [1, 2, 3]
    expect(arrayMove(arr, 1, 1)).toEqual([1, 2, 3])
  })

  it("does not mutate the original array", () => {
    const arr = ["x", "y", "z"]
    const result = arrayMove(arr, 0, 2)
    expect(arr).toEqual(["x", "y", "z"])
    expect(result).not.toBe(arr)
  })

  it("handles moving to the last position", () => {
    expect(arrayMove([1, 2, 3, 4], 0, 3)).toEqual([2, 3, 4, 1])
  })

  it("handles moving to the first position", () => {
    expect(arrayMove([1, 2, 3, 4], 3, 0)).toEqual([4, 1, 2, 3])
  })
})
