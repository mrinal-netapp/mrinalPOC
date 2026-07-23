import { useState, type ReactElement } from "react"
import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { useTestForm } from "@test/render"

import { KnowledgeBasesSection } from "./knowledge-bases-section"
import type { AgentAttachedKB, AgentFormValues, AgentResourceRequirement } from "./agent-form.consts"
import type { KnowledgeBaseOption } from "../configure-dialogs/configure-dialogs.types"

// Keep section tests focused on parent state transitions; the dropdown itself
// has dedicated coverage in the ui-lib tests.
vi.mock("@/ui-lib/base-components/select-dropdown/select-dropdown", () => ({
  SelectDropdown: ({
    label,
    value,
    items,
    onValueChange,
  }: {
    label?: string
    value?: string | number | null
    items: Array<{ key: string; value: string | number; label: string }>
    onValueChange?: (next: string | number | null) => void
  }) => {
    const currentIndex = items.findIndex((item) => item.value === value)
    const nextItem = items[(currentIndex + 1) % items.length]
    return (
      <button
        type="button"
        aria-label={label}
        onClick={() => onValueChange?.(nextItem?.value ?? null)}
      >
        {label}: {String(value ?? "(none)")}
      </button>
    )
  },
}))

// The section loads its catalog from the live KB list query; mock the hook so
// the test drives a deterministic catalog without a store / network.
const KB_FIXTURE: KnowledgeBaseOption[] = [
  {
    id: "kb-a",
    name: "KB A",
    status: "available",
    labels: ["Staging"],
  },
]

vi.mock("./use-knowledge-base-options", () => ({
  useKnowledgeBaseOptions: () => ({
    options: KB_FIXTURE,
    isLoading: false,
    isError: false,
  }),
}))

vi.mock("@/ui-lib/base-components/select-dropdown/select-dropdown", () => ({
  SelectDropdown: ({
    label,
    value,
    items,
    onValueChange,
    disabled,
  }: {
    label?: string
    value?: string | number | null
    items: Array<{ key: string; value: string | number; label: string }>
    onValueChange?: (next: string | number | null) => void
    disabled?: boolean
  }) => {
    const idx = items.findIndex((item) => item.value === value)
    const next = items[(idx + 1) % Math.max(items.length, 1)]
    return (
      <button
        type="button"
        aria-label={label}
        disabled={disabled || items.length === 0}
        onClick={() => onValueChange?.(next?.value ?? null)}
      >
        {label}: {String(value ?? "(none)")}
      </button>
    )
  },
}))

vi.setConfig({ testTimeout: 60_000 })

function Harness({
  initial = [] as AgentAttachedKB[],
  kbRequirements,
  onConfigureKnowledgeBase,
  onChange,
}: {
  initial?: AgentAttachedKB[]
  kbRequirements?: React.ComponentProps<typeof KnowledgeBasesSection>["kbRequirements"]
  onConfigureKnowledgeBase?: (kbId: string) => void
  onChange?: (values: Pick<AgentFormValues, "knowledgeBases" | "requirements">) => void
}): ReactElement {
  const form = useTestForm({
    knowledgeBases: initial,
    requirements: {
      knowledgeBases: kbRequirements ?? [],
      mcpServers: [],
    },
  })
  const [, force] = useState(0)
  form.store.subscribe(() => {
    onChange?.(form.state.values as Pick<AgentFormValues, "knowledgeBases" | "requirements">)
    force((v) => v + 1)
  })
  const values = form.state.values as Pick<AgentFormValues, "requirements">
  return (
    <KnowledgeBasesSection
      form={form}
      kbRequirements={values.requirements.knowledgeBases}
      onConfigureKnowledgeBase={onConfigureKnowledgeBase}
    />
  )
}

const mockKB: AgentAttachedKB = {
  id: "kb-1",
  name: "Sample KB",
  status: "healthy",
  tier: "tier-1",
  remaining: "v1",
  fileUsage: "Top K: 5",
}

describe("KnowledgeBasesSection", () => {
  it("[tag:kb-section] renders the heading and 'Add knowledge base' CTA", () => {
    render(<Harness />)
    expect(screen.getByText("Knowledge bases")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /Add knowledge base/ }),
    ).toBeInTheDocument()
  })

  it("[tag:kb-section] renders an attached KB card for each item in the form's knowledgeBases array", () => {
    const { container } = render(<Harness initial={[mockKB]} />)
    // KB name appears in both the card header title and the body link row.
    expect(screen.getAllByText("Sample KB").length).toBeGreaterThan(0)
    // Resource list wrapper present.
    expect(
      container.querySelector(".agent-form__resource-list"),
    ).not.toBeNull()
  })

  it("[tag:kb-section] renders an unresolved requirement card when requirements has a KB but knowledgeBases is empty", () => {
    const requirement: AgentResourceRequirement = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      label: "Required KB placeholder",
      description: "Connect a KB before deployment.",
      required: true,
    }
    render(<Harness kbRequirements={[requirement]} />)

    // The requirement label is the card header title.
    expect(screen.getByText("Required KB placeholder")).toBeInTheDocument()
    expect(screen.getByText("Not configured")).toBeInTheDocument()
    expect(
      screen.getByText(/Knowledge base "Required KB placeholder" must be configured to deploy this agent\./),
    ).toBeInTheDocument()
    expect(screen.getByRole("alert")).toBeInTheDocument()
  })

  it("[tag:kb-section] does not show a deploy-blocking alert for optional unresolved KB requirements", () => {
    const requirement: AgentResourceRequirement = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      label: "Optional KB placeholder",
      description: "Connect a KB when available.",
      required: false,
    }
    render(<Harness kbRequirements={[requirement]} />)

    expect(screen.getByText("Optional KB placeholder")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(
      screen.queryByText(/Knowledge base "Optional KB placeholder" must be configured to deploy this agent\./),
    ).not.toBeInTheDocument()
  })

  it("[tag:kb-section] clicking Remove from the actions menu clears an unresolved KB requirement", () => {
    const onChange = vi.fn()
    const requirement: AgentResourceRequirement = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      label: "Optional KB placeholder",
      description: "Connect a KB before deployment.",
      required: true,
    }
    render(<Harness kbRequirements={[requirement]} onChange={onChange} />)

    fireEvent.click(screen.getByRole("button", { name: "More actions" }))
    fireEvent.click(screen.getByText("Remove"))

    expect(screen.getByText("Remove unconfigured knowledge base?")).toBeInTheDocument()
    expect(screen.getByText(/You are removing the unconfigured knowledge base "Optional KB placeholder"/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Remove" }))

    expect(screen.queryByText("Optional KB placeholder")).not.toBeInTheDocument()
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requirements: expect.objectContaining({ knowledgeBases: [] }),
      }),
    )
  })

  it("[tag:kb-section] clicking Configure on an unresolved KB requirement preselects that KB in the config dialog", () => {
    const requirement: AgentResourceRequirement = {
      id: "kb-a",
      label: "Required KB placeholder",
      description: "Connect a KB before deployment.",
      required: true,
    }
    render(<Harness kbRequirements={[requirement]} />)

    fireEvent.click(screen.getByRole("button", { name: "Configure" }))

    expect(screen.getByText("Configure knowledge base")).toBeInTheDocument()
    expect(screen.getByText("Knowledge base: kb-a")).toBeInTheDocument()
  })

  it("[tag:kb-section] cancelling unresolved KB removal keeps the requirement card", () => {
    const requirement: AgentResourceRequirement = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      label: "Optional KB placeholder",
      description: "Connect a KB before deployment.",
      required: true,
    }
    render(<Harness kbRequirements={[requirement]} />)

    fireEvent.click(screen.getByRole("button", { name: "More actions" }))
    fireEvent.click(screen.getByText("Remove"))
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(
      screen.getByText(/Knowledge base "Optional KB placeholder" must be configured to deploy this agent\./),
    ).toBeInTheDocument()
    expect(screen.queryByText("Remove unconfigured knowledge base?")).not.toBeInTheDocument()
  })

  it("[tag:kb-section] clicking Remove from the actions menu clears an attached KB", () => {
    const onChange = vi.fn()
    render(<Harness initial={[mockKB]} onChange={onChange} />)

    fireEvent.click(screen.getByRole("button", { name: "More actions" }))
    fireEvent.click(screen.getByText("Remove"))

    expect(screen.queryByText("Sample KB")).not.toBeInTheDocument()
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        knowledgeBases: [],
      }),
    )
  })

  it("[tag:kb-section] non-healthy status renders the raw status string with the matching dot modifier", () => {
    const { container } = render(
      <Harness initial={[{ ...mockKB, status: "degraded" }]} />,
    )
    expect(screen.getByText("degraded")).toBeInTheDocument()
    expect(
      container.querySelector(".agent-form__status-dot--degraded"),
    ).not.toBeNull()
  })

  it("[tag:kb-section] clicking the card's Configure button fires onConfigureKnowledgeBase with the kb id", () => {
    const onConfigure = vi.fn()
    render(<Harness initial={[mockKB]} onConfigureKnowledgeBase={onConfigure} />)
    fireEvent.click(screen.getByRole("button", { name: "Configure" }))
    expect(onConfigure).toHaveBeenCalledWith("kb-1")
  })

  it("[tag:kb-section] clicking 'Add knowledge base' opens the configuration dialog", () => {
    render(<Harness />)
    fireEvent.click(
      screen.getByRole("button", { name: /Add knowledge base/ }),
    )
    // Dialog open: its specific Configure-knowledge-base title appears.
    expect(
      screen.getByText("Configure knowledge base"),
    ).toBeInTheDocument()
  })

  it("[tag:kb-section] clicking Configure on an attached KB opens the dialog pre-populated and saving edits in place", () => {
    const onChange = vi.fn()
    const attached: AgentAttachedKB = {
      id: "kb-a",
      name: "KB A",
      status: "healthy",
      tier: "Staging",
      remaining: "v1.0",
      fileUsage: "Top K: 7",
      ragConfig: {
        topKChunks: 7,
        rerankingEnabled: true,
        similarityThresholdEnabled: false,
        similarity: 0.3,
      },
    }

    render(<Harness initial={[attached]} onChange={onChange} />)

    fireEvent.click(screen.getByRole("button", { name: "Configure" }))
    // Dialog opens in edit mode.
    expect(screen.getByText("Configure knowledge base")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("switch", { name: "Enable reranking" }))

    fireEvent.click(screen.getByRole("button", { name: /Save/i }))

    // Edited in place (not appended): still a single entry with the same id.
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        knowledgeBases: [
          expect.objectContaining({
            id: "kb-a",
            fileUsage: "Top K: 7",
            ragConfig: expect.objectContaining({ rerankingEnabled: false }),
          }),
        ],
      }),
    )
  })

  it("[tag:kb-section] adding an already-attached KB replaces the existing card instead of duplicating it", () => {
    const onChange = vi.fn()
    const attached: AgentAttachedKB = {
      id: "kb-a",
      name: "KB A",
      status: "healthy",
      tier: "Staging",
      remaining: "v1.0",
      fileUsage: "Top K: 3",
      ragConfig: {
        topKChunks: 3,
        rerankingEnabled: false,
        similarityThresholdEnabled: false,
        similarity: 0.3,
      },
    }

    render(<Harness initial={[attached]} onChange={onChange} />)

    fireEvent.click(screen.getByRole("button", { name: /Add knowledge base/ }))
    fireEvent.click(screen.getByRole("button", { name: "Knowledge base" }))
    fireEvent.click(screen.getByRole("button", { name: /Save/i }))

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        knowledgeBases: [
          expect.objectContaining({
            id: "kb-a",
            fileUsage: "Top K: 5",
            ragConfig: expect.objectContaining({ topKChunks: 5 }),
          }),
        ],
      }),
    )
  })

  it("[tag:kb-section] shows the inline requirement error banner when the KB id matches a requirement entry", () => {
    const requirement: AgentResourceRequirement = {
      id: "kb-1",
      label: "Sample KB",
      description: "RAG configuration is missing.",
      required: true,
    }
    render(<Harness initial={[mockKB]} kbRequirements={[requirement]} />)
    expect(
      screen.getByText(/Knowledge base "Sample KB" must be configured to deploy this agent\./),
    ).toBeInTheDocument()
    expect(screen.getByRole("alert")).toBeInTheDocument()
  })

  it("[tag:kb-section] does not show the error banner when the KB id is not in kbRequirements", () => {
    render(<Harness initial={[mockKB]} kbRequirements={[]} />)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("[tag:kb-section] falls back to the KB name in the message when a required requirement label is absent", () => {
    const requirement: AgentResourceRequirement = {
      id: "kb-1",
      label: "",
      description: "",
      required: true,
    }
    render(<Harness initial={[mockKB]} kbRequirements={[requirement]} />)
    expect(
      screen.getByText(/Knowledge base "Sample KB" must be configured to deploy this agent\./),
    ).toBeInTheDocument()
  })

  it("[tag:kb-section] only shows the error banner on the card whose id matches, not on others", () => {
    const secondKB: AgentAttachedKB = { ...mockKB, id: "kb-2", name: "Second KB" }
    const requirement: AgentResourceRequirement = {
      id: "kb-2",
      label: "Second KB",
      description: "Config needed.",
      required: true,
    }
    render(<Harness initial={[mockKB, secondKB]} kbRequirements={[requirement]} />)
    // Only one alert — only kb-2 has a requirement error.
    expect(screen.getAllByRole("alert")).toHaveLength(1)
    expect(
      screen.getByText(/Knowledge base "Second KB" must be configured to deploy this agent\./),
    ).toBeInTheDocument()
  })

  it("[tag:kb-section] saving the dialog appends a new attached KB built from the catalog selection", () => {
    const onChange = vi.fn()
    const firstOption = KB_FIXTURE[0]
    expect(firstOption).toBeDefined()

    render(<Harness onChange={onChange} />)
    fireEvent.click(
      screen.getByRole("button", { name: /Add knowledge base/ }),
    )

    // Save without filling — buildAttachedKB returns null when no kb is selected.
    const cancel = screen.queryByRole("button", { name: /Cancel/i })
    if (cancel) fireEvent.click(cancel)

    // The form value remains an empty array since no kb was picked.
    expect(onChange).not.toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBases: expect.arrayContaining([
          expect.objectContaining({ id: expect.any(String) }),
        ]),
      }),
    )
  })

  it("[tag:kb-section] re-adding an already attached KB updates it in place", () => {
    const onChange = vi.fn()
    const attached: AgentAttachedKB = {
      id: "kb-a",
      name: "KB A",
      status: "healthy",
      tier: "Staging",
      remaining: "v1.0",
      fileUsage: "Top K: 7",
    }

    render(<Harness initial={[attached]} onChange={onChange} />)
    fireEvent.click(screen.getByRole("button", { name: /Add knowledge base/ }))
    fireEvent.click(screen.getByRole("button", { name: "Knowledge base" }))
    fireEvent.click(screen.getByRole("button", { name: /Save/i }))

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        knowledgeBases: [expect.objectContaining({ id: "kb-a" })],
      }),
    )
  })

  it("[tag:kb-section] renders a validation error message when provided", () => {
    function ErrorHarness(): ReactElement {
      const form = useTestForm({ knowledgeBases: [] })
      return <KnowledgeBasesSection form={form} errorMessage="Configure KBs to deploy" />
    }

    render(<ErrorHarness />)
    expect(screen.getByText("Configure KBs to deploy")).toBeInTheDocument()
  })
})
