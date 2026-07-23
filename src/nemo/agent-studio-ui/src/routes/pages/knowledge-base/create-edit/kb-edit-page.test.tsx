import { screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders } from "@test/render"
import type { KBDetail } from "@/api/kb.types"

vi.mock("./form/kb-form", () => ({
  KBForm: ({ isEdit, initialData }: { isEdit?: boolean; initialData?: KBDetail }) => (
    <div
      data-testid="kb-form"
      data-is-edit={isEdit ? "true" : "false"}
      data-name={initialData?.name}
    />
  ),
}))

const mockGetKB = vi.fn()
const mockGetAssignedDataset = vi.fn()

vi.mock("@/api/kb-api.slice", () => ({
  useGetKnowledgeBaseQuery: (...args: unknown[]) => mockGetKB(...args),
  useGetKBAssignedDatasetQuery: (...args: unknown[]) => mockGetAssignedDataset(...args),
}))

import { KBEditPage } from "./kb-edit-page"

const MOCK_DETAIL: KBDetail = {
  kb_id: "kb-abc",
  name: "My KB",
  status: "ready",
  deprecated: false,
  labels: [],
  created_at: "2024-01-01T00:00:00Z",
}

function renderEditPage(kbId?: string) {
  const path = kbId
    ? `/knowledge-bases/${kbId}/edit`
    : "/knowledge-bases/edit"
  const routePath = kbId
    ? "/knowledge-bases/:kbId/edit"
    : "/knowledge-bases/edit"

  return renderWithProviders(undefined, {
    routeConfig: [
      { path: routePath, element: <KBEditPage /> },
      { path: "/knowledge-bases", element: <div data-testid="kb-list" /> },
    ],
    initialEntries: [path],
  })
}

describe("KBEditPage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAssignedDataset.mockReturnValue({ data: undefined, isLoading: false, isError: false })
  })

  it("[tag:kb-edit-page] no kbId param → redirects to KB list", () => {
    mockGetKB.mockReturnValue({ data: undefined, isLoading: false, isError: false })
    renderEditPage()
    expect(screen.getByTestId("kb-list")).toBeInTheDocument()
  })

  it("[tag:kb-edit-page][tag:loading] isLoading → shows spinner", () => {
    mockGetKB.mockReturnValue({ data: undefined, isLoading: true, isError: false })
    renderEditPage("kb-abc")
    expect(document.querySelector(".dset-form-page__loading")).toBeInTheDocument()
    expect(screen.queryByTestId("kb-form")).not.toBeInTheDocument()
  })

  it("[tag:kb-edit-page][tag:error] error → shows error message", () => {
    mockGetKB.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    renderEditPage("kb-abc")
    expect(screen.getByText("Failed to load knowledge base.")).toBeInTheDocument()
    expect(screen.queryByTestId("kb-form")).not.toBeInTheDocument()
  })

  it("[tag:kb-edit-page] data loaded → KBForm receives isEdit and initialData", () => {
    mockGetKB.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })
    renderEditPage("kb-abc")
    const form = screen.getByTestId("kb-form")
    expect(form).toHaveAttribute("data-is-edit", "true")
    expect(form).toHaveAttribute("data-name", "My KB")
  })
})
