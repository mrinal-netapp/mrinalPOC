import { type ReactElement } from "react"
import { fireEvent, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { renderWithProviders, useTestForm } from "@test/render"

import { ModelSection } from "./model-section"
import { DEFAULT_MODEL_PARAMS } from "./agent-form.consts"

const mockUseListProjectModelsQuery = vi.fn()
let mockActiveProjectId = "project-a"

vi.setConfig({ testTimeout: 120_000 })

vi.mock("@/store", () => ({
  useAppSelector: () => mockActiveProjectId,
}))

vi.mock("@/routes/pages/agents/api/agents-config-api.slice", () => ({
  useListProjectModelsQuery: (...args: unknown[]) => mockUseListProjectModelsQuery(...args),
}))

function Harness(): ReactElement {
  const form = useTestForm({
    // Primary/fallback model values are config-service model UUIDs sourced
    // from the picker. The picker itself fetches options from the models API
    // (mocked in tests), so these can start empty.
    primaryModel: "",
    primaryModelParams: { ...DEFAULT_MODEL_PARAMS },
    fallbackModel: "",
    fallbackModelParams: { ...DEFAULT_MODEL_PARAMS },
  })
  return <ModelSection form={form} />
}

describe("ModelSection", () => {
  beforeEach(() => {
    mockActiveProjectId = "project-a"
    mockUseListProjectModelsQuery.mockReset()
    mockUseListProjectModelsQuery.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
    })
  })

  it("[tag:model-section] fetches LLM models for the active project", () => {
    renderWithProviders(<Harness />)

    expect(mockUseListProjectModelsQuery).toHaveBeenCalledWith(
      { projectId: "project-a", modelType: "llm" },
      { skip: false },
    )
  })

  it("[tag:model-section] skips model fetch when no project is active", () => {
    mockActiveProjectId = ""
    renderWithProviders(<Harness />)

    expect(mockUseListProjectModelsQuery).toHaveBeenCalledWith(
      { projectId: "", modelType: "llm" },
      { skip: true },
    )
  })

  it("[tag:model-section] renders the section heading", () => {
    renderWithProviders(<Harness />)
    expect(screen.getByText("Model")).toBeInTheDocument()
  })

  it("[tag:model-section] renders both Primary and Fallback model labels", () => {
    renderWithProviders(<Harness />)
    expect(screen.getByText("Primary model")).toBeInTheDocument()
    expect(screen.getByText("Fallback model")).toBeInTheDocument()
  })

  it("[tag:model-section] starts with both params collapsibles closed (aria-expanded=false)", () => {
    renderWithProviders(<Harness />)
    const toggles = screen
      .getAllByRole("button")
      .filter((b) => /Temperature, Top-p/.test(b.textContent ?? ""))
    expect(toggles.length).toBe(2)
    toggles.forEach((t) =>
      expect(t.getAttribute("aria-expanded")).toBe("false"),
    )
  })

  it("[tag:model-section] expanding a params collapsible reveals the slider labels and the toggle flips aria-expanded", () => {
    renderWithProviders(<Harness />)
    const primaryToggle = screen
      .getAllByRole("button")
      .find((b) =>
        /Temperature, Top-p, response length/.test(b.textContent ?? ""),
      )
    if (!primaryToggle) throw new Error("Primary collapsible not found")

    fireEvent.click(primaryToggle)
    expect(primaryToggle.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText("Temperature")).toBeInTheDocument()
    expect(screen.getByText("Top-p")).toBeInTheDocument()
    expect(screen.getByText("Response length")).toBeInTheDocument()

    fireEvent.click(primaryToggle)
    expect(primaryToggle.getAttribute("aria-expanded")).toBe("false")
  })

  it("[tag:model-section] fallback collapsible exposes the 'Maximum response length' label when expanded", () => {
    renderWithProviders(<Harness />)
    const fallbackToggle = screen
      .getAllByRole("button")
      .find((b) =>
        /Temperature, Top-p, maximum response length/.test(b.textContent ?? ""),
      )
    if (!fallbackToggle) throw new Error("Fallback collapsible not found")

    fireEvent.click(fallbackToggle)
    expect(screen.getByText("Maximum response length")).toBeInTheDocument()
  })
})
