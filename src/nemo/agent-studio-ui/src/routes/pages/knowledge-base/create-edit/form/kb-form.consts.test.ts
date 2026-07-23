import { describe, it, expect } from "vitest"

import {
  getKBChunkingStrategyLabel,
  KB_CHUNKING_STRATEGY_OPTIONS,
} from "./kb-form.consts"

describe("KB chunking strategy constants", () => {
  it("[tag:kb-form-consts] exposes five enabled chunking strategies with UI labels", () => {
    expect(KB_CHUNKING_STRATEGY_OPTIONS).toHaveLength(5)
    expect(KB_CHUNKING_STRATEGY_OPTIONS.map((o) => o.label)).toEqual([
      "Fixed Size",
      "Sentence-Based",
      "Recursive",
      "Token-Based",
      "Markdown-aware",
    ])
  })

  it("[tag:kb-form-consts] maps UI values to backend chunkStrategy identifiers", () => {
    expect(KB_CHUNKING_STRATEGY_OPTIONS.map((o) => o.key)).toEqual([
      "fixed",
      "sentence",
      "recursive",
      "token",
      "markdown",
    ])
    expect(KB_CHUNKING_STRATEGY_OPTIONS.map((o) => o.value)).toEqual([
      "chunk_by_character",
      "sentence",
      "recursive",
      "chunk_by_token",
      "hierarchical",
    ])
  })

  it("[tag:kb-form-consts] getKBChunkingStrategyLabel returns friendly labels", () => {
    expect(getKBChunkingStrategyLabel("chunk_by_character")).toBe("Fixed Size")
    expect(getKBChunkingStrategyLabel("sentence")).toBe("Sentence-Based")
    expect(getKBChunkingStrategyLabel("recursive")).toBe("Recursive")
    expect(getKBChunkingStrategyLabel("chunk_by_token")).toBe("Token-Based")
    expect(getKBChunkingStrategyLabel("hierarchical")).toBe("Markdown-aware")
    expect(getKBChunkingStrategyLabel(undefined)).toBe("—")
    expect(getKBChunkingStrategyLabel("semantic")).toBe("semantic")
  })
})
