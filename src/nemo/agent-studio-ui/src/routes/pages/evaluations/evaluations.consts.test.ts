import { describe, expect, it } from "vitest"

import { EVAL_STRINGS, evalPaths } from "./evaluations.consts"

describe("evaluations.consts", () => {
  it("[tag:eval] exposes page strings", () => {
    expect(EVAL_STRINGS.PAGE_TITLE).toBe("Evaluations")
    expect(EVAL_STRINGS.PAGE_SUBTITLE).toContain("eval suites")
  })

  it("[tag:eval] builds root, create, detail and edit paths", () => {
    expect(evalPaths.root).toBe("/evaluations")
    expect(evalPaths.create).toContain(evalPaths.root)
    expect(evalPaths.detail("evt-1")).toBe(`${evalPaths.root}/evt-1`)
    expect(evalPaths.edit("evt-1")).toContain("evt-1")
  })
})
