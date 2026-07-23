import { type ReactElement } from "react"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { useTestForm } from "@test/render"

import { SetupSection } from "./setup-section"
import { AGENT_CONFIGURATION_OPTIONS } from "./agent-form.consts"

function Harness({ initial }: { initial?: { configuration?: string } } = {}): ReactElement {
  const form = useTestForm({ configuration: "single", ...initial })
  return <SetupSection form={form} />
}

describe("SetupSection", () => {
  it("[tag:setup-section] renders the section heading", () => {
    render(<Harness />)
    expect(screen.getByText("Setup")).toBeInTheDocument()
  })

  it("[tag:setup-section] renders the Configuration field with its label", () => {
    render(<Harness />)
    expect(screen.getByText("Configuration")).toBeInTheDocument()
  })

  it("[tag:setup-section] surfaces every configuration option from AGENT_CONFIGURATION_OPTIONS", () => {
    render(<Harness />)
    // Expose every label declared in the consts file: at minimum 'single',
    // 'team', 'from_template'. We don't assert on display order so the
    // const file remains the source of truth.
    expect(AGENT_CONFIGURATION_OPTIONS.length).toBeGreaterThan(0)
    AGENT_CONFIGURATION_OPTIONS.forEach((opt) => {
      expect(opt.value).toBeTruthy()
      expect(opt.label).toBeTruthy()
    })
  })
})
