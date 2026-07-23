import { act, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { mockResizeObserver, type ResizeObserverHandle } from "@test/mocks"
import { renderWithProviders, userEvent } from "@test/render"

import { Chip, ChipList, ChipOverflow } from "./chip-list"

// ---- Chip ----

describe("Chip", () => {
  // 5.1
  it("[tag:chip] should render the label text", () => {
    // Setup + Execute
    renderWithProviders(<Chip label="Apple" />)

    // Validate
    expect(screen.getByText("Apple")).toBeInTheDocument()
  })

  // 5.2
  it("[tag:chip][tag:button] should render a remove button with the correct aria-label", () => {
    // Setup + Execute
    renderWithProviders(<Chip label="Apple" onRemove={vi.fn()} />)

    // Validate
    expect(screen.getByRole("button", { name: "Remove Apple" })).toBeInTheDocument()
  })

  it("[tag:chip][tag:button] should not throw when the remove button is clicked without an onRemove handler", async () => {
    // Setup — isRemovable=true (default), onRemove not provided
    const user = userEvent.setup()
    renderWithProviders(<Chip label="Apple" />)

    // Execute + Validate — clicking should not throw; covers the onRemove?.() undefined branch
    await expect(user.click(screen.getByRole("button", { name: "Remove Apple" }))).resolves.toBeUndefined()
  })

  it("[tag:chip][tag:button] should call onRemove when the remove button is clicked", async () => {
    // Setup
    const user = userEvent.setup()
    const onRemove = vi.fn()
    renderWithProviders(<Chip label="Apple" onRemove={onRemove} />)

    // Execute
    await user.click(screen.getByRole("button", { name: "Remove Apple" }))

    // Validate
    expect(onRemove).toHaveBeenCalledOnce()
  })

  // 5.3
  it("[tag:chip] should not render the remove button when isRemovable=false", () => {
    // Setup + Execute
    renderWithProviders(<Chip label="Apple" isRemovable={false} />)

    // Validate
    expect(screen.queryByRole("button", { name: /Remove/i })).not.toBeInTheDocument()
  })

  // 5.4
  it("[tag:chip][tag:button][tag:disabled] should not call onRemove when the chip is disabled", async () => {
    // Setup
    const user = userEvent.setup()
    const onRemove = vi.fn()
    renderWithProviders(<Chip label="Apple" onRemove={onRemove} isDisabled={true} />)

    // Execute
    await user.click(screen.getByRole("button", { name: "Remove Apple" }))

    // Validate
    expect(onRemove).not.toHaveBeenCalled()
  })

  it("[tag:chip][tag:disabled] should apply the disabled class on the remove button when isDisabled=true", () => {
    // Setup + Execute
    renderWithProviders(<Chip label="Apple" isDisabled={true} />)

    // Validate
    expect(screen.getByRole("button", { name: "Remove Apple" })).toHaveClass("chip__remove--disabled")
  })

  // 5.5
  it("[tag:chip][tag:variant] should apply the default CVA variant classes", () => {
    // Setup + Execute
    const { container } = renderWithProviders(<Chip label="Apple" />)
    const chipEl = container.firstChild as HTMLElement

    // Validate
    expect(chipEl).toHaveClass("chip--type-tag", "chip--color-tag1", "chip--size-regular")
  })

  // 5.6
  it("[tag:chip] should apply a custom className to the chip element", () => {
    // Setup + Execute
    const { container } = renderWithProviders(<Chip label="Apple" className="my-chip" />)

    // Validate
    expect(container.firstChild).toHaveClass("my-chip")
  })

  it("[tag:chip] should apply a custom style to the chip element", () => {
    // Setup + Execute
    const { container } = renderWithProviders(<Chip label="Apple" style={{ color: "red" }} />)

    // Validate

    // Check the inline style property directly — toHaveStyle uses getComputedStyle which normalises named colours to rgb()
    expect((container.firstChild as HTMLElement).style.color).toBe("red")
  })
})

// ---- ChipOverflow ----

describe("ChipOverflow", () => {
  // 5.7
  it("[tag:chip] should display the +N count text", () => {
    // Setup + Execute
    renderWithProviders(<ChipOverflow count={3} />)

    // Validate
    expect(screen.getByText("+3")).toBeInTheDocument()
  })

  it("[tag:chip] should apply the chip--overflow class", () => {
    // Setup + Execute
    const { container } = renderWithProviders(<ChipOverflow count={3} />)

    // Validate
    expect(container.firstChild).toHaveClass("chip--overflow")
  })

  // 5.8
  it("[tag:chip][tag:variant] should apply default CVA variant classes", () => {
    // Setup + Execute
    const { container } = renderWithProviders(<ChipOverflow count={2} />)
    const el = container.firstChild as HTMLElement

    // Validate
    expect(el).toHaveClass("chip--type-tag", "chip--color-tag1", "chip--size-regular")
  })

  it("[tag:chip] should forward className to the overflow element", () => {
    // Setup + Execute
    const { container } = renderWithProviders(<ChipOverflow count={2} className="overflow-custom" />)

    // Validate
    expect(container.firstChild).toHaveClass("overflow-custom")
  })

  it("[tag:chip] should forward style to the overflow element", () => {
    // Setup + Execute
    const { container } = renderWithProviders(<ChipOverflow count={2} style={{ opacity: 0.5 }} />)

    // Validate
    expect(container.firstChild as HTMLElement).toHaveStyle({ opacity: "0.5" })
  })
})

// ---- ChipList ----

describe("ChipList", () => {
  const values = ["apple", "banana", "cherry"]
  const getLabel = (v: unknown): string => String(v)

  let roHandle: ResizeObserverHandle

  beforeEach(() => {
    roHandle = mockResizeObserver()
  })

  afterEach(() => {
    roHandle.cleanup()
  })

  // 5.9
  it("[tag:chip][tag:list] should render all chip labels", () => {
    // Setup + Execute
    renderWithProviders(<ChipList values={values} getLabel={getLabel} isDisabled={false} />)

    // Validate
    expect(screen.getByText("apple")).toBeInTheDocument()
    expect(screen.getByText("banana")).toBeInTheDocument()
    expect(screen.getByText("cherry")).toBeInTheDocument()
  })

  // 5.10
  it("[tag:chip][tag:list][tag:button] should call onRemove with the correct value when a chip remove button is clicked", async () => {
    // Setup
    const user = userEvent.setup()
    const onRemove = vi.fn()
    renderWithProviders(
      <ChipList values={values} getLabel={getLabel} onRemove={onRemove} isDisabled={false} />,
    )

    // Execute
    await user.click(screen.getByRole("button", { name: "Remove banana" }))

    // Validate
    expect(onRemove).toHaveBeenCalledOnce()
    expect(onRemove).toHaveBeenCalledWith("banana")
  })

  // 5.11
  it("[tag:chip][tag:list][tag:variant] should apply chip-list--row class when orientation is row", () => {
    // Setup + Execute
    const { container } = renderWithProviders(
      <ChipList values={values} getLabel={getLabel} isDisabled={false} orientation="row" />,
    )

    // Validate
    expect(container.firstChild).toHaveClass("chip-list--row")
  })

  it("[tag:chip][tag:list][tag:variant] should apply chip-list--column class when orientation is column", () => {
    // Setup + Execute
    const { container } = renderWithProviders(
      <ChipList values={values} getLabel={getLabel} isDisabled={false} orientation="column" />,
    )

    // Validate
    expect(container.firstChild).toHaveClass("chip-list--column")
  })

  // 5.12
  it("[tag:chip][tag:list][tag:button][tag:disabled] should propagate isDisabled to all chips — remove buttons do not call onRemove", async () => {
    // Setup
    const user = userEvent.setup()
    const onRemove = vi.fn()
    renderWithProviders(
      <ChipList values={values} getLabel={getLabel} onRemove={onRemove} isDisabled={true} />,
    )

    // Execute — attempt to click every remove button
    for (const label of values) {
      await user.click(screen.getByRole("button", { name: `Remove ${label}` }))
    }

    // Validate
    expect(onRemove).not.toHaveBeenCalled()
  })

  // 5.13
  it("[tag:chip][tag:list] should hide all remove buttons when isRemovable=false", () => {
    // Setup + Execute
    renderWithProviders(
      <ChipList values={values} getLabel={getLabel} isDisabled={false} isRemovable={false} />,
    )

    // Validate
    expect(screen.queryAllByRole("button", { name: /Remove/i })).toHaveLength(0)
  })

  // 5.14
  it("[tag:chip][tag:list][tag:overflow] should hide overflowed chips and show the overflow badge with the correct count", async () => {
    // Setup
    const { container } = renderWithProviders(
      <ChipList values={values} getLabel={getLabel} isDisabled={false} gapPx={4} />,
    )
    const listEl = container.firstChild as HTMLElement

    // container children: [chip0, chip1, chip2, overflowBadge]
    const children = Array.from(listEl.children) as HTMLElement[]
    const [chip0, chip1, chip2, overflowBadge] = children

    // Simulate a narrow container (width=100) where only the first chip fits
    // chip offsetWidth=60, overflowWidth=30+4=34
    // chip0: spaceNeeded = 60 + 34 = 94 ≤ 100 → visible (count=1)
    // chip1: spaceNeeded = 60 + 64 + 34 = 158 > 100 → break
    Object.defineProperty(listEl, "clientWidth", { get: () => 100, configurable: true })
      ;[chip0, chip1, chip2].forEach((el) => {
        Object.defineProperty(el, "offsetWidth", { get: () => 60, configurable: true })
      })
    Object.defineProperty(overflowBadge, "offsetWidth", { get: () => 30, configurable: true })

    // Execute — trigger the ResizeObserver callback to recompute
    expect(roHandle.capturedCallback).not.toBeNull()
    await act(async () => {
      roHandle.capturedCallback!([], {} as ResizeObserver)
    })

    // Validate — chip0 is visible, chip1 and chip2 are hidden
    expect(chip0).not.toHaveStyle({ visibility: "hidden" })
    expect(chip1).toHaveStyle({ visibility: "hidden" })
    expect(chip2).toHaveStyle({ visibility: "hidden" })

    // Overflow badge shows "+2" and is not hidden
    expect(overflowBadge).toHaveTextContent("+2")
    expect(overflowBadge).not.toHaveStyle({ visibility: "hidden" })
  })

  it("[tag:chip][tag:list][tag:overflow] should keep all chips visible and hide the overflow badge when the container fits all chips", async () => {
    // Setup
    const { container } = renderWithProviders(
      <ChipList values={values} getLabel={getLabel} isDisabled={false} gapPx={4} />,
    )
    const listEl = container.firstChild as HTMLElement
    const children = Array.from(listEl.children) as HTMLElement[]
    const [chip0, chip1, chip2, overflowBadge] = children

    // Wide container (width=1000): all 3 chips fit
    // chip0: spaceNeeded = 0 + 60 + 34 = 94 ≤ 1000 → visible
    // chip1: spaceNeeded = 60 + 64 + 34 = 158 ≤ 1000 → visible
    // chip2 (last): hasMore=false → spaceNeeded = 158 + 64 + 0 = 222 ≤ 1000 → visible
    //   covers the `hasMore ? overflowWidth : 0` false branch (line 129)
    // Initial visibleCount = 3, computed next = 3 → prev === next
    //   covers the `prev === next ? prev : next` true branch (line 137)
    Object.defineProperty(listEl, "clientWidth", { get: () => 1000, configurable: true })
      ;[chip0, chip1, chip2].forEach((el) => {
        Object.defineProperty(el, "offsetWidth", { get: () => 60, configurable: true })
      })
    Object.defineProperty(overflowBadge, "offsetWidth", { get: () => 30, configurable: true })

    // Execute
    expect(roHandle.capturedCallback).not.toBeNull()
    await act(async () => {
      roHandle.capturedCallback!([], {} as ResizeObserver)
    })

    // Validate — all chips remain visible
    expect(chip0).not.toHaveStyle({ visibility: "hidden" })
    expect(chip1).not.toHaveStyle({ visibility: "hidden" })
    expect(chip2).not.toHaveStyle({ visibility: "hidden" })

    // Overflow badge is hidden (hiddenCount=0)
    expect(overflowBadge).toHaveStyle({ visibility: "hidden" })
  })

  it("[tag:chip][tag:list][tag:overflow] should show at least 1 chip when the container is extremely narrow (Math.max guard)", async () => {
    // Setup
    const { container } = renderWithProviders(
      <ChipList values={values} getLabel={getLabel} isDisabled={false} gapPx={4} />,
    )
    const listEl = container.firstChild as HTMLElement
    const children = Array.from(listEl.children) as HTMLElement[]
    const [chip0, chip1, chip2, overflowBadge] = children

    // Extremely narrow container (width=10) — chip0 alone cannot fit either
    // chip0: spaceNeeded = 0 + 60 + 34 = 94 > 10 → break immediately, count=0
    // Math.max(1, 0) = 1 → first chip remains visible
    Object.defineProperty(listEl, "clientWidth", { get: () => 10, configurable: true })
      ;[chip0, chip1, chip2].forEach((el) => {
        Object.defineProperty(el, "offsetWidth", { get: () => 60, configurable: true })
      })
    Object.defineProperty(overflowBadge, "offsetWidth", { get: () => 30, configurable: true })

    // Execute
    expect(roHandle.capturedCallback).not.toBeNull()
    await act(async () => {
      roHandle.capturedCallback!([], {} as ResizeObserver)
    })

    // Validate — at least 1 chip is visible; the rest are hidden
    expect(chip0).not.toHaveStyle({ visibility: "hidden" })
    expect(chip1).toHaveStyle({ visibility: "hidden" })
    expect(chip2).toHaveStyle({ visibility: "hidden" })

    // Overflow badge shows "+2" (3 values − 1 visible)
    expect(overflowBadge).toHaveTextContent("+2")
  })

  it("[tag:chip][tag:list][tag:overflow] should hide overflow badge and all chips when values is empty", async () => {
    // Setup — render with empty values array
    const { container } = renderWithProviders(
      <ChipList values={[]} getLabel={getLabel} isDisabled={false} gapPx={4} />,
    )
    const listEl = container.firstChild as HTMLElement
    const children = Array.from(listEl.children) as HTMLElement[]
    const overflowBadge = children[0] // Only the overflow badge exists

    // Wide container — no chips to display
    Object.defineProperty(listEl, "clientWidth", { get: () => 1000, configurable: true })
    Object.defineProperty(overflowBadge, "offsetWidth", { get: () => 30, configurable: true })

    // Execute
    expect(roHandle.capturedCallback).not.toBeNull()
    await act(async () => {
      roHandle.capturedCallback!([], {} as ResizeObserver)
    })

    // Validate — overflow badge is hidden (hiddenCount should be 0, not -1)
    expect(overflowBadge).toHaveStyle({ visibility: "hidden" })
  })
})
