import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { mockResizeObserver, type ResizeObserverHandle } from "@test/mocks"
import { renderWithProviders } from "@test/render"

import { ADD_TOOL_DEFAULT_LABEL_ITEMS, ADD_TOOL_DEFAULT_SELECTED_LABELS } from "../add-tool.consts"
import { ADD_TOOL_DEFAULT_CATALOG_STATE } from "./catalog.consts"
import type { CatalogFormState } from "./catalog.types"

import { CatalogTabContent } from "./catalog-tab-content"

describe("CatalogTabContent", () => {
  let roHandle: ResizeObserverHandle
  const defaultProps = {
    formState: { ...ADD_TOOL_DEFAULT_CATALOG_STATE } as CatalogFormState,
    labelItems: ADD_TOOL_DEFAULT_LABEL_ITEMS,
    selectedLabels: ADD_TOOL_DEFAULT_SELECTED_LABELS,
    onSelectTemplate: vi.fn(),
    onNameChange: vi.fn(),
    onDescriptionChange: vi.fn(),
    onLabelChange: vi.fn(),
    onAddLabel: vi.fn(),
  }

  beforeEach(() => {
    roHandle = mockResizeObserver()
  })

  afterEach(() => {
    roHandle.cleanup()
  })

  it("[tag:catalog-tab] renders the template table with all catalog templates", async () => {
    const user = userEvent.setup({ delay: null })
    renderWithProviders(<CatalogTabContent {...defaultProps} />)

    // NetApp storage templates
    expect(screen.getByText("Azure NetApp Files")).toBeInTheDocument()
    expect(screen.getByText("Azure NetApp Files Logs")).toBeInTheDocument()
    expect(screen.getByText("Amazon FSxN")).toBeInTheDocument()
    expect(screen.getByText("Google Cloud NetApp Volumes")).toBeInTheDocument()
    expect(screen.getByText("Google Cloud NetApp Volumes Logs")).toBeInTheDocument()
    expect(screen.getByText("NetApp ONTAP")).toBeInTheDocument()
    // Analytics templates
    expect(screen.getByText("Analytics Datasets")).toBeInTheDocument()
    expect(screen.getByText("DuckDB Iceberg")).toBeInTheDocument()
    // General-purpose templates
    expect(screen.getByText("PostgreSQL")).toBeInTheDocument()
    expect(screen.getByText("GitHub")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Go to next page" }))
    expect(screen.getByText("Tavily Web Search")).toBeInTheDocument()
  })

  it("[tag:catalog-tab] shows Name/Description/Labels fields after selecting a template", () => {
    const formWithTemplate: CatalogFormState = {
      ...ADD_TOOL_DEFAULT_CATALOG_STATE,
      selectedTemplateId: "azure_netapp_files",
      catalogName: "Azure NetApp Files",
      catalogDescription: "Enterprise file storage",
    }

    renderWithProviders(
      <CatalogTabContent {...defaultProps} formState={formWithTemplate} />,
    )

    expect(screen.getByLabelText("Name")).toBeInTheDocument()
    expect(screen.getByLabelText("Description")).toBeInTheDocument()
    expect(screen.getByText("Labels")).toBeInTheDocument()
  })

  it("[tag:catalog-tab] hides Name/Description/Labels when no template selected", () => {
    renderWithProviders(<CatalogTabContent {...defaultProps} />)

    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Description")).not.toBeInTheDocument()
  })

  it("[tag:catalog-tab] calls onSelectTemplate when a row radio is selected", async () => {
    const onSelectTemplate = vi.fn()
    const user = userEvent.setup({ delay: null })

    renderWithProviders(
      <CatalogTabContent {...defaultProps} onSelectTemplate={onSelectTemplate} />,
    )

    await user.click(screen.getByRole("radio", { name: /Amazon FSxN/i }))
    expect(onSelectTemplate).toHaveBeenCalledWith("fsxn")
  })

  it("[tag:catalog-tab] calls field handlers when template is selected", async () => {
    const onNameChange = vi.fn()
    const onDescriptionChange = vi.fn()
    const user = userEvent.setup({ delay: null })
    const formWithTemplate: CatalogFormState = {
      ...ADD_TOOL_DEFAULT_CATALOG_STATE,
      selectedTemplateId: "azure_netapp_files",
      catalogName: "Azure NetApp Files",
    }

    renderWithProviders(
      <CatalogTabContent
        {...defaultProps}
        formState={formWithTemplate}
        onNameChange={onNameChange}
        onDescriptionChange={onDescriptionChange}
      />,
    )

    await user.clear(screen.getByLabelText("Name"))
    await user.type(screen.getByLabelText("Name"), "renamed")
    await user.type(screen.getByLabelText("Description"), "desc")

    expect(onNameChange).toHaveBeenCalled()
    expect(onDescriptionChange).toHaveBeenCalled()
  })

  it("[tag:catalog-tab] shows name validation when showValidation is true", () => {
    const formWithTemplate: CatalogFormState = {
      ...ADD_TOOL_DEFAULT_CATALOG_STATE,
      selectedTemplateId: "azure_netapp_files",
      catalogName: "",
    }

    renderWithProviders(
      <CatalogTabContent {...defaultProps} formState={formWithTemplate} showValidation />,
    )

    expect(screen.getByText("Name is required")).toBeInTheDocument()
  })
})
