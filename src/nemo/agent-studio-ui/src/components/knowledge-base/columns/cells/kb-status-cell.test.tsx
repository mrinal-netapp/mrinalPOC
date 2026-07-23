import { screen } from "@testing-library/react"
import { describe, it, expect } from "vitest"

import { renderWithProviders } from "@test/render"
import type { KBStatus } from "@/api/kb.types"
import { KBStatusCell } from "./kb-status-cell"

describe("KBStatusCell", () => {
  const statusCases: { status: KBStatus; deprecated: boolean; expectedLabel: string }[] = [
    { status: "ready", deprecated: false, expectedLabel: "Ready" },
    { status: "in_progress", deprecated: false, expectedLabel: "In Progress" },
    { status: "errored", deprecated: false, expectedLabel: "Errored" },
    { status: "deprecated", deprecated: false, expectedLabel: "Deprecated" },
    { status: "ready", deprecated: true, expectedLabel: "Deprecated" },
    { status: "in_progress", deprecated: true, expectedLabel: "Deprecated" },
    { status: "errored", deprecated: true, expectedLabel: "Deprecated" },
    { status: "deprecated", deprecated: true, expectedLabel: "Deprecated" },
  ]

  statusCases.forEach(({ status, deprecated, expectedLabel }) => {
    it(`[tag:kb][tag:status-cell] renders '${expectedLabel}' for status=${status} deprecated=${deprecated}`, () => {
      renderWithProviders(
        <KBStatusCell status={status} deprecated={deprecated} />,
      )
      expect(screen.getByText(expectedLabel)).toBeInTheDocument()
    })
  })
})
