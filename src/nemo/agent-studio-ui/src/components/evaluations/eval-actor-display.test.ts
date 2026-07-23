import { describe, expect, it } from "vitest"

import { displayEvalActor } from "./eval-actor-display"

describe("displayEvalActor", () => {
  it("[tag:eval] returns the trimmed value when present", () => {
    expect(displayEvalActor("  Sarah Chen  ")).toBe("Sarah Chen")
  })

  it("[tag:eval] returns an em dash for empty, whitespace, null, or undefined", () => {
    expect(displayEvalActor("")).toBe("—")
    expect(displayEvalActor("   ")).toBe("—")
    expect(displayEvalActor(null)).toBe("—")
    expect(displayEvalActor(undefined)).toBe("—")
  })
})
