import React, { useState } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

// Stub SelectDropdown: a labelled button that cycles through items on click.
// It picks the NEXT item from the current value's index — lets us drive the
// KB dropdown deterministically.
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
    const idx = items.findIndex((i) => i.value === value)
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

import {
  DEFAULT_KNOWLEDGE_BASE_CONFIG,
  KNOWLEDGE_BASE_CONFIG_STRINGS,
} from "./configure-dialogs.consts"
import type {
  KnowledgeBaseConfig,
  KnowledgeBaseOption,
} from "./configure-dialogs.types"
import { KnowledgeBaseConfigDialog } from "./knowledge-base-config-dialog"

const handlers = () => ({
  onClose: vi.fn(),
  onDraftChange: vi.fn(),
  onSave: vi.fn(),
})

function renderDialog(
  draft: KnowledgeBaseConfig,
  knowledgeBases: KnowledgeBaseOption[] = FIXTURE,
  extra?: Partial<ReturnType<typeof handlers>>,
) {
  const h = { ...handlers(), ...extra }
  const result = render(
    <KnowledgeBaseConfigDialog
      open
      draft={draft}
      knowledgeBases={knowledgeBases}
      {...h}
    />,
  )
  return { ...result, ...h }
}

const FIXTURE: KnowledgeBaseOption[] = [
  {
    id: "kb-a",
    name: "KB A",
    status: "available",
    labels: ["Staging", "Sales"],
  },
  {
    id: "kb-b",
    name: "KB B",
    status: "indexing",
    labels: ["Production"],
  },
]

describe("KnowledgeBaseConfigDialog", () => {
  it("[tag:knowledge-base-config-dialog] renders nothing when closed", () => {
    const { container } = render(
      <KnowledgeBaseConfigDialog
        open={false}
        draft={DEFAULT_KNOWLEDGE_BASE_CONFIG}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    expect(
      container.querySelector(".knowledge-base-config-dialog"),
    ).not.toBeInTheDocument()
  })

  it("[tag:knowledge-base-config-dialog] renders title and all section headings", () => {
    renderDialog(DEFAULT_KNOWLEDGE_BASE_CONFIG)

    expect(screen.getByText(KNOWLEDGE_BASE_CONFIG_STRINGS.DIALOG_TITLE)).toBeInTheDocument()
    expect(screen.getByText(KNOWLEDGE_BASE_CONFIG_STRINGS.KB_SECTION_TITLE)).toBeInTheDocument()
    expect(screen.getByText(KNOWLEDGE_BASE_CONFIG_STRINGS.TOP_K_TITLE)).toBeInTheDocument()
    expect(screen.getByText(KNOWLEDGE_BASE_CONFIG_STRINGS.RERANKING_TITLE)).toBeInTheDocument()
    expect(
      screen.getByText(KNOWLEDGE_BASE_CONFIG_STRINGS.SIMILARITY_THRESHOLD_TITLE),
    ).toBeInTheDocument()
  })

  it("[tag:knowledge-base-config-dialog] picking a KB shows Status and Labels", () => {
    renderDialog(
      { ...DEFAULT_KNOWLEDGE_BASE_CONFIG, knowledgeBaseId: "kb-a" },
      FIXTURE,
    )

    expect(screen.getByText("Available")).toBeInTheDocument()
    expect(screen.getByText("Staging, Sales")).toBeInTheDocument()
  })

  it("[tag:knowledge-base-config-dialog] selecting a new KB emits only the knowledgeBaseId", async () => {
    const user = userEvent.setup({ delay: null })
    const onDraftChange = vi.fn()

    renderDialog(
      { ...DEFAULT_KNOWLEDGE_BASE_CONFIG, knowledgeBaseId: "kb-a" },
      FIXTURE,
      { onDraftChange },
    )

    await user.click(screen.getByRole("button", { name: "Knowledge base" }))

    expect(onDraftChange).toHaveBeenCalledWith({ knowledgeBaseId: "kb-b" })
  })

  it("[tag:knowledge-base-config-dialog] toggling Reranking emits onDraftChange", async () => {
    const user = userEvent.setup({ delay: null })
    const onDraftChange = vi.fn()

    renderDialog(
      { ...DEFAULT_KNOWLEDGE_BASE_CONFIG, rerankingEnabled: false },
      FIXTURE,
      { onDraftChange },
    )

    await user.click(
      screen.getByRole("switch", { name: KNOWLEDGE_BASE_CONFIG_STRINGS.RERANKING_TOGGLE_LABEL }),
    )

    expect(onDraftChange).toHaveBeenLastCalledWith({ rerankingEnabled: true })
  })

  it("[tag:knowledge-base-config-dialog] disabling the similarity-threshold toggle hides the Similarity slider", () => {
    const { rerender } = renderDialog(
      { ...DEFAULT_KNOWLEDGE_BASE_CONFIG, knowledgeBaseId: "kb-a" },
      FIXTURE,
    )

    expect(screen.getByText(KNOWLEDGE_BASE_CONFIG_STRINGS.SIMILARITY_LABEL)).toBeInTheDocument()

    rerender(
      <KnowledgeBaseConfigDialog
        open
        draft={{
          ...DEFAULT_KNOWLEDGE_BASE_CONFIG,
          knowledgeBaseId: "kb-a",
          similarityThresholdEnabled: false,
        }}
        knowledgeBases={FIXTURE}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    )

    expect(screen.queryByText(KNOWLEDGE_BASE_CONFIG_STRINGS.SIMILARITY_LABEL)).not.toBeInTheDocument()
  })

  it("[tag:knowledge-base-config-dialog] blocks Save when KB is missing", async () => {
    const user = userEvent.setup({ delay: null })
    const onSave = vi.fn()

    renderDialog(DEFAULT_KNOWLEDGE_BASE_CONFIG, FIXTURE, { onSave })

    await user.click(
      screen.getByRole("button", { name: KNOWLEDGE_BASE_CONFIG_STRINGS.SAVE_ACTION_LABEL }),
    )

    expect(onSave).not.toHaveBeenCalled()
    expect(
      screen.getByText(KNOWLEDGE_BASE_CONFIG_STRINGS.KB_REQUIRED_ERROR),
    ).toBeInTheDocument()
  })

  it("[tag:knowledge-base-config-dialog] fires onSave when a KB is set", async () => {
    const user = userEvent.setup({ delay: null })
    const onSave = vi.fn()

    renderDialog(
      { ...DEFAULT_KNOWLEDGE_BASE_CONFIG, knowledgeBaseId: "kb-a" },
      FIXTURE,
      { onSave },
    )

    await user.click(
      screen.getByRole("button", { name: KNOWLEDGE_BASE_CONFIG_STRINGS.SAVE_ACTION_LABEL }),
    )

    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("[tag:knowledge-base-config-dialog] Cancel fires onClose", async () => {
    const user = userEvent.setup({ delay: null })
    const onClose = vi.fn()

    renderDialog(DEFAULT_KNOWLEDGE_BASE_CONFIG, FIXTURE, { onClose })

    await user.click(
      screen.getByRole("button", { name: KNOWLEDGE_BASE_CONFIG_STRINGS.CANCEL_ACTION_LABEL }),
    )

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("[tag:knowledge-base-config-dialog] state-managed integration: toggle similarity threshold off then back on preserves slider value", async () => {
    const user = userEvent.setup({ delay: null })

    function Harness(): React.ReactElement {
      const [draft, setDraft] = useState<KnowledgeBaseConfig>({
        ...DEFAULT_KNOWLEDGE_BASE_CONFIG,
        knowledgeBaseId: "kb-a",
        similarity: 0.75,
      })
      return (
        <KnowledgeBaseConfigDialog
          open
          draft={draft}
          knowledgeBases={FIXTURE}
          onClose={vi.fn()}
          onSave={vi.fn()}
          onDraftChange={(next) => setDraft((prev) => ({ ...prev, ...next }))}
        />
      )
    }

    render(<Harness />)

    const simToggle = screen.getByRole("switch", {
      name: KNOWLEDGE_BASE_CONFIG_STRINGS.SIMILARITY_THRESHOLD_TOGGLE_LABEL,
    })

    // Off — Similarity sub-field disappears
    await user.click(simToggle)
    expect(
      screen.queryByText(KNOWLEDGE_BASE_CONFIG_STRINGS.SIMILARITY_LABEL),
    ).not.toBeInTheDocument()

    // On again — value preserved (we never reset similarity)
    await user.click(simToggle)
    expect(
      screen.getByText(KNOWLEDGE_BASE_CONFIG_STRINGS.SIMILARITY_LABEL),
    ).toBeInTheDocument()
  })
})
