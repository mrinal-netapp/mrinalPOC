import { render, screen } from "@testing-library/react"
import { describe, it, expect } from "vitest"

import { MetricsRow } from "./metrics-row"
import type { MetricItem } from "./metrics-row.types"

const METRICS: MetricItem[] = [
  { icon: <span data-testid="m1-icon" />, value: "42", subtitle: "Requests" },
  { icon: <span data-testid="m2-icon" />, value: "245", units: "ms", subtitle: "Average latency" },
]

describe("MetricsRow", () => {
  it("[tag:metrics-row] renders each metric's value, units, and subtitle", () => {
    render(<MetricsRow metrics={METRICS} />)
    expect(screen.getByText("42")).toBeInTheDocument()
    expect(screen.getByText("245")).toBeInTheDocument()
    expect(screen.getByText("ms")).toBeInTheDocument()
    expect(screen.getByText("Requests")).toBeInTheDocument()
    expect(screen.getByText("Average latency")).toBeInTheDocument()
  })

  it("[tag:metrics-row] appends a custom className to the root", () => {
    const { container } = render(<MetricsRow metrics={METRICS} className="custom-row" />)
    const root = container.querySelector(".metrics-row")
    expect(root).not.toBeNull()
    expect(root?.className).toContain("custom-row")
  })
})
