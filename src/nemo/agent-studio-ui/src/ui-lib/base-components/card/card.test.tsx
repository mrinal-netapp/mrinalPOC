import { fireEvent, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@test/render"

import { Card } from "./card"
import { CardHeader } from "./card.header"
import { CardFooter } from "./card.footer"
import { CardContent } from "./card.content"
import { CardContentLayout } from "./card.content-layout"
import {
  CardBlock,
  CardBlockLabel,
  CardBlockValue,
  CardBlockMetric,
  CardBlockStatus,
  CardBlockKeyValueList,
} from "./card.block"

// ===== Card =====

describe("Card", () => {
  // 1.1 (merged 1.5)
  it("[tag:card][tag:render] should render with data-slot, base class, and no role/tabindex by default", () => {
    const { container } = renderWithProviders(<Card>content</Card>)

    const root = container.querySelector("[data-slot='card']")
    expect(root).toBeInTheDocument()
    expect(root).toHaveClass("card")
    expect(root).not.toHaveAttribute("role")
    expect(root).not.toHaveAttribute("tabindex")
  })

  // 1.2
  it("[tag:card][tag:render] should render children inside the card", () => {
    renderWithProviders(<Card><span>child text</span></Card>)

    expect(screen.getByText("child text")).toBeInTheDocument()
  })

  // 1.3
  it("[tag:card][tag:className] should append custom className", () => {
    const { container } = renderWithProviders(<Card className="my-card">content</Card>)

    expect(container.querySelector(".card.my-card")).toBeInTheDocument()
  })

  // 1.6
  it("[tag:card][tag:disabled] should apply disabled class and remove button semantics when isDisabled with onClick", () => {
    const { container } = renderWithProviders(<Card isDisabled onClick={vi.fn()}>content</Card>)

    const root = container.querySelector("[data-slot='card']")
    expect(root).toHaveClass("card--disabled")
    expect(root).toHaveClass("card--clickable")
    expect(root).not.toHaveAttribute("role")
    expect(root).not.toHaveAttribute("tabindex")
  })

  // 1.7
  it("[tag:card][tag:onClick] should fire onClick when card is clicked", () => {
    const handleClick = vi.fn()
    const { container } = renderWithProviders(<Card onClick={handleClick}>content</Card>)

    fireEvent.click(container.querySelector("[data-slot='card']")!)
    expect(handleClick).toHaveBeenCalledOnce()
  })

  // 1.8
  it("[tag:card][tag:onClick] should infer clickable from onClick (role and tabindex present)", () => {
    const { container } = renderWithProviders(<Card onClick={vi.fn()}>content</Card>)

    const root = container.querySelector("[data-slot='card']")
    expect(root).toHaveClass("card--clickable")
    expect(root).toHaveAttribute("role", "button")
    expect(root).toHaveAttribute("tabindex", "0")
  })

  // 1.9
  it("[tag:card][tag:onClick][tag:disabled] should not fire onClick when isDisabled is true", () => {
    const handleClick = vi.fn()
    const { container } = renderWithProviders(
      <Card onClick={handleClick} isDisabled>content</Card>,
    )

    fireEvent.click(container.querySelector("[data-slot='card']")!)
    expect(handleClick).not.toHaveBeenCalled()
  })

  // 1.10 — Enter fires on keyDown, Space fires on keyUp (native button parity)
  it("[tag:card][tag:keyboard] should fire onClick on Enter keyDown and Space keyUp, and ignore other keys", () => {
    const handleClick = vi.fn()
    const { container } = renderWithProviders(
      <Card onClick={handleClick}>content</Card>,
    )

    const root = container.querySelector("[data-slot='card']")!

    fireEvent.keyDown(root, { key: "Enter" })
    expect(handleClick).toHaveBeenCalledTimes(1)

    // Space keyDown should preventDefault (scroll suppression) but NOT fire onClick
    const spacePrevented = fireEvent.keyDown(root, { key: " " })
    expect(handleClick).toHaveBeenCalledTimes(1)
    expect(spacePrevented).toBe(false)

    // Space keyUp fires onClick
    fireEvent.keyUp(root, { key: " " })
    expect(handleClick).toHaveBeenCalledTimes(2)

    // Non-activation keys are ignored on both keyDown and keyUp
    fireEvent.keyDown(root, { key: "Tab" })
    fireEvent.keyUp(root, { key: "Tab" })
    expect(handleClick).toHaveBeenCalledTimes(2)
  })

  // 1.13 — bubbled key events from descendants are ignored
  it("[tag:card][tag:keyboard] should ignore key events bubbling from child elements", () => {
    const handleClick = vi.fn()
    renderWithProviders(
      <Card onClick={handleClick}>
        <button data-testid="inner-btn">inner</button>
      </Card>,
    )

    const innerBtn = screen.getByTestId("inner-btn")

    fireEvent.keyDown(innerBtn, { key: "Enter" })
    fireEvent.keyUp(innerBtn, { key: " " })
    expect(handleClick).not.toHaveBeenCalled()
  })

  // 1.14
  it("[tag:card][tag:keyboard][tag:disabled] should not fire onClick on keyboard when isDisabled", () => {
    const handleClick = vi.fn()
    const { container } = renderWithProviders(
      <Card onClick={handleClick} isDisabled>content</Card>,
    )

    const root = container.querySelector("[data-slot='card']")!
    fireEvent.keyDown(root, { key: "Enter" })
    fireEvent.keyUp(root, { key: " " })
    expect(handleClick).not.toHaveBeenCalled()
  })
})

// ===== CardHeader =====

describe("CardHeader", () => {
  // 2.1 (merged 2.4, 2.6, 2.7, 2.10)
  it("[tag:card-header][tag:render] should render default state: data-slot, no subtitle, no icon, horizontal, no separator", () => {
    const { container } = renderWithProviders(<CardHeader title="Title" />)

    expect(container.querySelector("[data-slot='card-header']")).toBeInTheDocument()
    expect(container.querySelector(".card-header__subtitle")).not.toBeInTheDocument()
    expect(container.querySelector(".card-header__icon")).not.toBeInTheDocument()
    expect(container.querySelector(".card-header__left")).toBeInTheDocument()
    expect(container.querySelector(".card-header__left--vertical")).not.toBeInTheDocument()
    expect(container.querySelector(".card-header--separator")).not.toBeInTheDocument()
  })

  // 2.2
  it("[tag:card-header][tag:title] should render title text", () => {
    renderWithProviders(<CardHeader title="My Title" />)

    expect(screen.getByText("My Title")).toBeInTheDocument()
  })

  // 2.3
  it("[tag:card-header][tag:subtitle] should render subtitle when provided", () => {
    renderWithProviders(<CardHeader title="Title" subtitle="Subtitle" />)

    expect(screen.getByText("Subtitle")).toBeInTheDocument()
  })

  // 2.5
  it("[tag:card-header][tag:icon] should render icon in card-header__icon wrapper", () => {
    const { container } = renderWithProviders(
      <CardHeader title="Title" icon={<svg data-testid="icon" />} />,
    )

    expect(container.querySelector(".card-header__icon")).toBeInTheDocument()
    expect(screen.getByTestId("icon")).toBeInTheDocument()
  })

  // 2.8
  it("[tag:card-header][tag:orientation] should apply vertical modifier class when orientation is vertical", () => {
    const { container } = renderWithProviders(
      <CardHeader title="Title" orientation="vertical" />,
    )

    expect(container.querySelector(".card-header__left--vertical")).toBeInTheDocument()
  })

  // 2.9
  it("[tag:card-header][tag:separator] should apply card-header--separator class when hasSeparator is true", () => {
    const { container } = renderWithProviders(<CardHeader title="Title" hasSeparator />)

    expect(container.querySelector(".card-header--separator")).toBeInTheDocument()
  })

  // 2.11
  it("[tag:card-header][tag:actions] should render up to 2 actions in card-header__actions", () => {
    const { container } = renderWithProviders(
      <CardHeader
        title="Title"
        actions={[
          <button key="1">A1</button>,
          <button key="2">A2</button>,
          <button key="3">A3</button>,
        ]}
      />,
    )

    const actionsContainer = container.querySelector(".card-header__actions")
    expect(actionsContainer).toBeInTheDocument()
    expect(actionsContainer!.children).toHaveLength(2)
  })

  // 2.12
  it("[tag:card-header][tag:actions] should not render actions wrapper when actions array is empty", () => {
    const { container } = renderWithProviders(<CardHeader title="Title" actions={[]} />)

    expect(container.querySelector(".card-header__actions")).not.toBeInTheDocument()
  })

  // 2.13
  it("[tag:card-header][tag:className] should append custom className", () => {
    const { container } = renderWithProviders(
      <CardHeader title="Title" className="custom-header" />,
    )

    expect(container.querySelector(".card-header.custom-header")).toBeInTheDocument()
  })
})

// ===== CardFooter =====

describe("CardFooter", () => {
  // 3.1 (merged 3.2, 3.6, 3.10)
  it("[tag:card-footer][tag:render] should render default state: data-slot, alignment-end, no separator, no cancel", () => {
    const { container } = renderWithProviders(<CardFooter />)

    expect(container.querySelector("[data-slot='card-footer']")).toBeInTheDocument()
    expect(container.querySelector(".card-footer-alignment-end")).toBeInTheDocument()
    expect(container.querySelector(".card-footer--has-separator")).not.toBeInTheDocument()
    expect(container.querySelector(".card-footer__cancel")).not.toBeInTheDocument()
  })

  // 3.3
  it("[tag:card-footer][tag:alignment] should apply card-footer-alignment-start class", () => {
    const { container } = renderWithProviders(<CardFooter alignment="start" />)

    expect(container.querySelector(".card-footer-alignment-start")).toBeInTheDocument()
  })

  // 3.4
  it("[tag:card-footer][tag:alignment] should apply card-footer-alignment-center class", () => {
    const { container } = renderWithProviders(<CardFooter alignment="center" />)

    expect(container.querySelector(".card-footer-alignment-center")).toBeInTheDocument()
  })

  // 3.5
  it("[tag:card-footer][tag:separator] should apply card-footer--has-separator class when hasSeparator is true", () => {
    const { container } = renderWithProviders(<CardFooter hasSeparator />)

    expect(container.querySelector(".card-footer--has-separator")).toBeInTheDocument()
  })

  // 3.7
  it("[tag:card-footer][tag:actions] should render up to 2 action buttons in card-footer__actions", () => {
    const { container } = renderWithProviders(
      <CardFooter actions={[{ label: "Save" }, { label: "Apply" }]} />,
    )

    const actionsContainer = container.querySelector(".card-footer__actions")
    expect(actionsContainer).toBeInTheDocument()
    expect(actionsContainer!.children).toHaveLength(2)
  })

  // 3.8
  it("[tag:card-footer][tag:actions] should cap actions at 2 when more are provided", () => {
    const { container } = renderWithProviders(
      <CardFooter actions={[{ label: "A1" }, { label: "A2" }, { label: "A3" }]} />,
    )

    expect(container.querySelector(".card-footer__actions")!.children).toHaveLength(2)
  })

  // 3.9 (merged 3.11)
  it("[tag:card-footer][tag:cancel] should render cancel button with wrapper and has-cancel modifier", () => {
    const { container } = renderWithProviders(
      <CardFooter cancelButton={{ label: "Cancel" }} />,
    )

    expect(container.querySelector(".card-footer__cancel")).toBeInTheDocument()
    expect(screen.getByText("Cancel")).toBeInTheDocument()
    expect(container.querySelector(".card-footer--has-cancel")).toBeInTheDocument()
  })

  // 3.12
  it("[tag:card-footer][tag:children] should render direct children and bypass structured layout", () => {
    renderWithProviders(
      <CardFooter><span>Custom footer content</span></CardFooter>,
    )

    expect(screen.getByText("Custom footer content")).toBeInTheDocument()
  })

  // 3.13
  it("[tag:card-footer][tag:children] should not render actions wrapper when children are provided", () => {
    const { container } = renderWithProviders(
      <CardFooter actions={[{ label: "Save" }]}>
        <span>Override</span>
      </CardFooter>,
    )

    expect(container.querySelector(".card-footer__actions")).not.toBeInTheDocument()
    expect(screen.getByText("Override")).toBeInTheDocument()
  })

  // 3.14a
  it("[tag:card-footer][tag:fill] should render fill variant without actions (empty fallback)", () => {
    const { container } = renderWithProviders(<CardFooter variant="fill" />)

    expect(container.querySelector(".card-footer--fill")).toBeInTheDocument()
    expect(container.querySelectorAll(".card-footer__fill-action")).toHaveLength(0)
  })

  // 3.14b (merged 3.15)
  it("[tag:card-footer][tag:fill] should apply fill class, render fill actions with separator", () => {
    const { container } = renderWithProviders(
      <CardFooter
        variant="fill"
        actions={[{ label: "Accept" }, { label: "Decline" }]}
      />,
    )

    expect(container.querySelector(".card-footer--fill")).toBeInTheDocument()
    const fillActions = container.querySelectorAll(".card-footer__fill-action")
    expect(fillActions).toHaveLength(2)
    expect(container.querySelector(".card-footer__fill-separator")).toBeInTheDocument()
  })

  // 3.14c
  it("[tag:card-footer][tag:fill] should force flat variant on fill action buttons", () => {
    const { container } = renderWithProviders(
      <CardFooter variant="fill" actions={[{ label: "Accept", variant: "solid" }]} />,
    )

    const btn = container.querySelector(".card-footer__fill-action [data-slot='button']")
    expect(btn).toHaveClass("btn-variant-flat")
  })

  // 3.16
  it("[tag:card-footer][tag:fill] should cap fill actions at 2", () => {
    const { container } = renderWithProviders(
      <CardFooter
        variant="fill"
        actions={[{ label: "A" }, { label: "B" }, { label: "C" }]}
      />,
    )

    expect(container.querySelectorAll(".card-footer__fill-action")).toHaveLength(2)
  })

  // 3.17
  it("[tag:card-footer][tag:className] should append custom className", () => {
    const { container } = renderWithProviders(<CardFooter className="custom-footer" />)

    expect(container.querySelector(".card-footer.custom-footer")).toBeInTheDocument()
  })
})

// ===== CardContent =====

describe("CardContent", () => {
  // 4.1
  it("[tag:card-content][tag:render] should render with data-slot='card-content'", () => {
    const { container } = renderWithProviders(<CardContent>blocks</CardContent>)

    expect(container.querySelector("[data-slot='card-content']")).toBeInTheDocument()
  })

  // 4.2
  it("[tag:card-content][tag:render] should render children inside content", () => {
    renderWithProviders(<CardContent><span>block child</span></CardContent>)

    expect(screen.getByText("block child")).toBeInTheDocument()
  })

  // 4.3
  it("[tag:card-content][tag:className] should append custom className", () => {
    const { container } = renderWithProviders(
      <CardContent className="custom-content">blocks</CardContent>,
    )

    expect(container.querySelector(".card-content.custom-content")).toBeInTheDocument()
  })
})

// ===== CardContentLayout =====

describe("CardContentLayout", () => {
  // 5.1
  it("[tag:card-content-layout][tag:render] should render with data-slot='card-content-layout'", () => {
    const { container } = renderWithProviders(
      <CardContentLayout columns={3}>blocks</CardContentLayout>,
    )

    expect(container.querySelector("[data-slot='card-content-layout']")).toBeInTheDocument()
  })

  // 5.2
  it("[tag:card-content-layout][tag:render] should render children", () => {
    renderWithProviders(
      <CardContentLayout columns={2}><span>grid child</span></CardContentLayout>,
    )

    expect(screen.getByText("grid child")).toBeInTheDocument()
  })

  // 5.3
  it("[tag:card-content-layout][tag:columns] should set gridTemplateColumns based on columns prop", () => {
    const { container } = renderWithProviders(
      <CardContentLayout columns={4}>blocks</CardContentLayout>,
    )

    const layout = container.querySelector("[data-slot='card-content-layout']") as HTMLElement
    expect(layout.style.gridTemplateColumns).toBe("repeat(4, 1fr)")
  })

  // 5.4
  it("[tag:card-content-layout][tag:className] should append custom className", () => {
    const { container } = renderWithProviders(
      <CardContentLayout columns={2} className="custom-layout">blocks</CardContentLayout>,
    )

    expect(container.querySelector(".card-content-layout.custom-layout")).toBeInTheDocument()
  })
})

// ===== CardBlock =====

describe("CardBlock", () => {
  // 6.1 (merged 6.4, 6.6)
  it("[tag:card-block][tag:render] should render default state: data-slot, no separator, no side-separator", () => {
    const { container } = renderWithProviders(<CardBlock>content</CardBlock>)

    expect(container.querySelector("[data-slot='card-block']")).toBeInTheDocument()
    expect(container.querySelector(".card-block--separator")).not.toBeInTheDocument()
    expect(container.querySelector(".card-block--side-separator")).not.toBeInTheDocument()
  })

  // 6.2
  it.each([
    ["key-value", "card-block-type-key-value"],
    ["metric", "card-block-type-metric"],
    ["description", "card-block-type-description"],
    ["status", "card-block-type-status"],
    ["list", "card-block-type-list"],
    ["info-row", "card-block-type-info-row"],
    ["link-row", "card-block-type-link-row"],
    ["progress", "card-block-type-progress"],
  ] as const)("[tag:card-block][tag:type] should apply %s variant class", (type, expectedClass) => {
    const { container } = renderWithProviders(<CardBlock type={type}>content</CardBlock>)

    expect(container.querySelector(`.${expectedClass}`)).toBeInTheDocument()
  })

  // 6.3
  it("[tag:card-block][tag:separator] should apply card-block--separator class when hasSeparator is true", () => {
    const { container } = renderWithProviders(<CardBlock hasSeparator>content</CardBlock>)

    expect(container.querySelector(".card-block--separator")).toBeInTheDocument()
  })

  // 6.5
  it("[tag:card-block][tag:side-separator] should apply card-block--side-separator class when hasSideSeparator is true", () => {
    const { container } = renderWithProviders(<CardBlock hasSideSeparator>content</CardBlock>)

    expect(container.querySelector(".card-block--side-separator")).toBeInTheDocument()
  })

  // 6.7
  it("[tag:card-block][tag:separator] should support both separators simultaneously", () => {
    const { container } = renderWithProviders(
      <CardBlock hasSeparator hasSideSeparator>content</CardBlock>,
    )

    const block = container.querySelector("[data-slot='card-block']")
    expect(block).toHaveClass("card-block--separator")
    expect(block).toHaveClass("card-block--side-separator")
  })

  // 6.8
  it("[tag:card-block][tag:clickable] should apply clickable class, role, and tabindex when onClick is provided", () => {
    const { container } = renderWithProviders(<CardBlock onClick={vi.fn()}>content</CardBlock>)

    const block = container.querySelector("[data-slot='card-block']")!
    expect(block).toHaveClass("card-block--clickable")
    expect(block).toHaveAttribute("role", "button")
    expect(block).toHaveAttribute("tabindex", "0")
  })

  // 6.9
  it("[tag:card-block][tag:onClick] should fire onClick when block is clicked", () => {
    const handleClick = vi.fn()
    const { container } = renderWithProviders(
      <CardBlock onClick={handleClick}>content</CardBlock>,
    )

    fireEvent.click(container.querySelector("[data-slot='card-block']")!)
    expect(handleClick).toHaveBeenCalledOnce()
  })

  // 6.10
  it("[tag:card-block][tag:disabled] should apply disabled class and remove button semantics when isDisabled with onClick", () => {
    const { container } = renderWithProviders(
      <CardBlock isDisabled onClick={vi.fn()}>content</CardBlock>,
    )

    const block = container.querySelector("[data-slot='card-block']")
    expect(block).toHaveClass("card-block--disabled")
    expect(block).toHaveClass("card-block--clickable")
    expect(block).not.toHaveAttribute("role")
    expect(block).not.toHaveAttribute("tabindex")
  })

  // 6.11
  it("[tag:card-block][tag:onClick][tag:disabled] should not fire onClick when isDisabled is true", () => {
    const handleClick = vi.fn()
    const { container } = renderWithProviders(
      <CardBlock onClick={handleClick} isDisabled>content</CardBlock>,
    )

    fireEvent.click(container.querySelector("[data-slot='card-block']")!)
    expect(handleClick).not.toHaveBeenCalled()
  })

  // 6.12 — Enter fires on keyDown, Space fires on keyUp (native button parity)
  it("[tag:card-block][tag:keyboard] should fire onClick on Enter keyDown and Space keyUp, and ignore other keys", () => {
    const handleClick = vi.fn()
    const { container } = renderWithProviders(
      <CardBlock onClick={handleClick}>content</CardBlock>,
    )

    const block = container.querySelector("[data-slot='card-block']")!

    fireEvent.keyDown(block, { key: "Enter" })
    expect(handleClick).toHaveBeenCalledTimes(1)

    // Space keyDown should preventDefault (scroll suppression) but NOT fire onClick
    const spacePrevented = fireEvent.keyDown(block, { key: " " })
    expect(handleClick).toHaveBeenCalledTimes(1)
    expect(spacePrevented).toBe(false)

    // Space keyUp fires onClick
    fireEvent.keyUp(block, { key: " " })
    expect(handleClick).toHaveBeenCalledTimes(2)

    // Non-activation keys are ignored on both keyDown and keyUp
    fireEvent.keyDown(block, { key: "Tab" })
    fireEvent.keyUp(block, { key: "Tab" })
    expect(handleClick).toHaveBeenCalledTimes(2)
  })

  // 6.15 — bubbled key events from descendants are ignored
  it("[tag:card-block][tag:keyboard] should ignore key events bubbling from child elements", () => {
    const handleClick = vi.fn()
    renderWithProviders(
      <CardBlock onClick={handleClick}>
        <button data-testid="inner-btn">inner</button>
      </CardBlock>,
    )

    const innerBtn = screen.getByTestId("inner-btn")

    fireEvent.keyDown(innerBtn, { key: "Enter" })
    fireEvent.keyUp(innerBtn, { key: " " })
    expect(handleClick).not.toHaveBeenCalled()
  })

  // 6.16
  it("[tag:card-block][tag:keyboard][tag:disabled] should not fire onClick on keyboard when isDisabled", () => {
    const handleClick = vi.fn()
    const { container } = renderWithProviders(
      <CardBlock onClick={handleClick} isDisabled>content</CardBlock>,
    )

    const block = container.querySelector("[data-slot='card-block']")!
    fireEvent.keyDown(block, { key: "Enter" })
    fireEvent.keyUp(block, { key: " " })
    expect(handleClick).not.toHaveBeenCalled()
  })

  // 6.17
  it("[tag:card-block][tag:render] should render children content", () => {
    renderWithProviders(<CardBlock><span>block child</span></CardBlock>)

    expect(screen.getByText("block child")).toBeInTheDocument()
  })

  // 6.18
  it("[tag:card-block][tag:className] should append custom className", () => {
    const { container } = renderWithProviders(
      <CardBlock className="custom-block">content</CardBlock>,
    )

    expect(container.querySelector(".card-block.custom-block")).toBeInTheDocument()
  })
})

// ===== CardBlockLabel =====

describe("CardBlockLabel", () => {
  // 7.1
  it("[tag:card-block-label][tag:render] should render text with card-block__label class", () => {
    const { container } = renderWithProviders(<CardBlockLabel>Region</CardBlockLabel>)

    expect(screen.getByText("Region")).toBeInTheDocument()
    expect(container.querySelector(".card-block__label")).toBeInTheDocument()
  })

  // 7.2
  it("[tag:card-block-label][tag:ellipsis] should pass isEllipsis to Typography", () => {
    const { container } = renderWithProviders(
      <CardBlockLabel isEllipsis>Long text that overflows</CardBlockLabel>,
    )

    expect(container.querySelector(".typography--ellipsis")).toBeInTheDocument()
  })

  // 7.3
  it("[tag:card-block-label][tag:ellipsis] should not apply ellipsis class by default", () => {
    const { container } = renderWithProviders(<CardBlockLabel>Short</CardBlockLabel>)

    expect(container.querySelector(".typography--ellipsis")).not.toBeInTheDocument()
  })

  // 7.4
  it("[tag:card-block-label][tag:className] should append custom className", () => {
    const { container } = renderWithProviders(
      <CardBlockLabel className="custom-label">Text</CardBlockLabel>,
    )

    expect(container.querySelector(".card-block__label.custom-label")).toBeInTheDocument()
  })
})

// ===== CardBlockValue =====

describe("CardBlockValue", () => {
  // 8.1
  it("[tag:card-block-value][tag:render] should render text with card-block__value class", () => {
    const { container } = renderWithProviders(<CardBlockValue>US-East-1</CardBlockValue>)

    expect(screen.getByText("US-East-1")).toBeInTheDocument()
    expect(container.querySelector(".card-block__value")).toBeInTheDocument()
  })

  // 8.2
  it("[tag:card-block-value][tag:ellipsis] should pass isEllipsis to Typography", () => {
    const { container } = renderWithProviders(
      <CardBlockValue isEllipsis>Long value that overflows</CardBlockValue>,
    )

    expect(container.querySelector(".typography--ellipsis")).toBeInTheDocument()
  })

  // 8.3
  it("[tag:card-block-value][tag:ellipsis] should not apply ellipsis class by default", () => {
    const { container } = renderWithProviders(<CardBlockValue>Short</CardBlockValue>)

    expect(container.querySelector(".typography--ellipsis")).not.toBeInTheDocument()
  })

  // 8.4
  it("[tag:card-block-value][tag:className] should append custom className", () => {
    const { container } = renderWithProviders(
      <CardBlockValue className="custom-value">Text</CardBlockValue>,
    )

    expect(container.querySelector(".card-block__value.custom-value")).toBeInTheDocument()
  })
})

// ===== CardBlockMetric =====

describe("CardBlockMetric", () => {
  // 9.1
  it("[tag:card-block-metric][tag:render] should render value with card-block-metric class", () => {
    const { container } = renderWithProviders(<CardBlockMetric value="1,234" />)

    expect(screen.getByText("1,234")).toBeInTheDocument()
    expect(container.querySelector(".card-block-metric")).toBeInTheDocument()
  })

  // 9.2
  it("[tag:card-block-metric][tag:subtitle] should render subtitle when provided", () => {
    renderWithProviders(<CardBlockMetric value="42" subtitle="Total items" />)

    expect(screen.getByText("42")).toBeInTheDocument()
    expect(screen.getByText("Total items")).toBeInTheDocument()
  })

  // 9.3
  it("[tag:card-block-metric][tag:subtitle] should not render subtitle element when omitted", () => {
    const { container } = renderWithProviders(<CardBlockMetric value="42" />)

    expect(container.querySelector(".card-block-metric__subtitle")).not.toBeInTheDocument()
  })

  // 9.4
  it("[tag:card-block-metric][tag:units] should render units next to value", () => {
    const { container } = renderWithProviders(<CardBlockMetric value="2.4" units="GB" />)

    expect(screen.getByText("2.4")).toBeInTheDocument()
    expect(screen.getByText("GB")).toBeInTheDocument()
    expect(container.querySelector(".card-block-metric__units")).toBeInTheDocument()
  })

  // 9.5
  it("[tag:card-block-metric][tag:units] should not render units element when omitted", () => {
    const { container } = renderWithProviders(<CardBlockMetric value="100" />)

    expect(container.querySelector(".card-block-metric__units")).not.toBeInTheDocument()
  })

  // 9.6
  it("[tag:card-block-metric][tag:icon] should render icon in card-block-metric__icon wrapper", () => {
    const { container } = renderWithProviders(
      <CardBlockMetric value="5" icon={<svg data-testid="metric-icon" />} />,
    )

    expect(container.querySelector(".card-block-metric__icon")).toBeInTheDocument()
    expect(screen.getByTestId("metric-icon")).toBeInTheDocument()
  })

  // 9.7 (merged 9.8)
  it("[tag:card-block-metric][tag:defaults] should default to no icon, horizontal orientation", () => {
    const { container } = renderWithProviders(<CardBlockMetric value="5" />)

    expect(container.querySelector(".card-block-metric__icon")).not.toBeInTheDocument()
    expect(container.querySelector(".card-block-metric--horizontal")).toBeInTheDocument()
    expect(container.querySelector(".card-block-metric--vertical")).not.toBeInTheDocument()
  })

  // 9.9
  it("[tag:card-block-metric][tag:orientation] should apply vertical modifier when orientation is vertical", () => {
    const { container } = renderWithProviders(
      <CardBlockMetric value="5" orientation="vertical" />,
    )

    expect(container.querySelector(".card-block-metric--vertical")).toBeInTheDocument()
    expect(container.querySelector(".card-block-metric--horizontal")).not.toBeInTheDocument()
  })

  // 9.10
  it("[tag:card-block-metric][tag:defaults] should apply default fs32 regular for value and fs16 regular for units", () => {
    const { container } = renderWithProviders(
      <CardBlockMetric value="99" units="%" />,
    )

    const valuEl = container.querySelector(".card-block-metric__value")
    expect(valuEl).toHaveClass("typography--32")
    expect(valuEl).toHaveClass("typography--regular")

    const unitEl = container.querySelector(".card-block-metric__units")
    expect(unitEl).toHaveClass("typography--16")
    expect(unitEl).toHaveClass("typography--regular")
  })

  // 9.11
  it("[tag:card-block-metric][tag:custom-size] should apply custom valueSize and unitSize", () => {
    const { container } = renderWithProviders(
      <CardBlockMetric value="$62" units="USD" valueSize="fs20" unitSize="fs14" />,
    )

    expect(container.querySelector(".card-block-metric__value")).toHaveClass("typography--20")
    expect(container.querySelector(".card-block-metric__units")).toHaveClass("typography--14")
  })

  // 9.12
  it("[tag:card-block-metric][tag:custom-boldness] should apply custom valueType and unitType", () => {
    const { container } = renderWithProviders(
      <CardBlockMetric value="100" units="%" valueType="semibold" unitType="semibold" />,
    )

    expect(container.querySelector(".card-block-metric__value")).toHaveClass("typography--semibold")
    expect(container.querySelector(".card-block-metric__units")).toHaveClass("typography--semibold")
  })

  // 9.13
  it("[tag:card-block-metric][tag:className] should append custom className", () => {
    const { container } = renderWithProviders(
      <CardBlockMetric value="5" className="custom-metric" />,
    )

    expect(container.querySelector(".card-block-metric.custom-metric")).toBeInTheDocument()
  })

  // 9.14
  it("[tag:card-block-metric][tag:full] should render icon, value, units, and subtitle together", () => {
    const { container } = renderWithProviders(
      <CardBlockMetric
        value="2.4"
        units="GB"
        subtitle="Index size"
        icon={<svg data-testid="full-icon" />}
        orientation="horizontal"
      />,
    )

    expect(screen.getByTestId("full-icon")).toBeInTheDocument()
    expect(screen.getByText("2.4")).toBeInTheDocument()
    expect(screen.getByText("GB")).toBeInTheDocument()
    expect(screen.getByText("Index size")).toBeInTheDocument()
    expect(container.querySelector(".card-block-metric--horizontal")).toBeInTheDocument()
  })
})

// ===== CardBlockStatus =====

describe("CardBlockStatus", () => {
  // 10.1
  it("[tag:card-block-status][tag:render] should render status dot and children", () => {
    const { container } = renderWithProviders(
      <CardBlockStatus status="success">Healthy</CardBlockStatus>,
    )

    expect(screen.getByText("Healthy")).toBeInTheDocument()
    expect(container.querySelector(".card-block__status-dot")).toBeInTheDocument()
  })

  // 10.2
  it.each([
    ["success", "card-block__status-dot--success"],
    ["error", "card-block__status-dot--error"],
    ["warning", "card-block__status-dot--warning"],
    ["info", "card-block__status-dot--info"],
    ["neutral", "card-block__status-dot--neutral"],
  ] as const)("[tag:card-block-status][tag:status] should apply %s status modifier", (status, expectedClass) => {
    const { container } = renderWithProviders(
      <CardBlockStatus status={status}>text</CardBlockStatus>,
    )

    expect(container.querySelector(`.${expectedClass}`)).toBeInTheDocument()
  })

  // 10.3
  it("[tag:card-block-status][tag:className] should append custom className", () => {
    const { container } = renderWithProviders(
      <CardBlockStatus status="success" className="custom-status">Ok</CardBlockStatus>,
    )

    expect(container.querySelector(".card-block__status.custom-status")).toBeInTheDocument()
  })
})

// ===== CardBlockKeyValueList =====

describe("CardBlockKeyValueList", () => {
  it("[tag:card-block-kv-list][tag:render] should render all rows with label and value", () => {
    const rows = [
      { label: "Region", value: "US-East-1" },
      { label: "Status", value: "Active" },
    ]
    renderWithProviders(<CardBlockKeyValueList rows={rows} />)

    expect(screen.getByText("Region")).toBeInTheDocument()
    expect(screen.getByText("US-East-1")).toBeInTheDocument()
    expect(screen.getByText("Status")).toBeInTheDocument()
    expect(screen.getByText("Active")).toBeInTheDocument()
  })

  it("[tag:card-block-kv-list][tag:key] should not produce duplicate keys when labels repeat", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const rows = [
      { label: "Status", value: "Active" },
      { label: "Status", value: "Pending" },
    ]
    renderWithProviders(<CardBlockKeyValueList rows={rows} />)

    const keyWarnings = consoleSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("key"),
    )
    expect(keyWarnings).toHaveLength(0)
    consoleSpy.mockRestore()
  })

  it("[tag:card-block-kv-list][tag:separator] should apply separator to all rows except the last", () => {
    const rows = [
      { label: "A", value: "1" },
      { label: "B", value: "2" },
      { label: "C", value: "3" },
    ]
    const { container } = renderWithProviders(<CardBlockKeyValueList rows={rows} />)

    const blocks = container.querySelectorAll("[data-slot='card-block']")
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toHaveClass("card-block--separator")
    expect(blocks[1]).toHaveClass("card-block--separator")
    expect(blocks[2]).not.toHaveClass("card-block--separator")
  })

  it("[tag:card-block-kv-list][tag:render] should render ReactElement values directly", () => {
    const rows = [
      { label: "Custom", value: <span data-testid="custom-el">Custom content</span> },
    ]
    renderWithProviders(<CardBlockKeyValueList rows={rows} />)

    expect(screen.getByTestId("custom-el")).toBeInTheDocument()
  })

  it("[tag:card-block-kv-list][tag:render] should wrap numeric values in CardBlockValue with semibold styling", () => {
    const rows = [{ label: "Count", value: 42 }]
    const { container } = renderWithProviders(<CardBlockKeyValueList rows={rows} />)

    const valueEl = container.querySelector(".card-block__value")
    expect(valueEl).toBeInTheDocument()
    expect(valueEl).toHaveTextContent("42")
    expect(valueEl).toHaveClass("typography--semibold")
  })

  it("[tag:card-block-kv-list][tag:render] should wrap boolean values in CardBlockValue with semibold styling", () => {
    const rows = [{ label: "Enabled", value: true }]
    const { container } = renderWithProviders(<CardBlockKeyValueList rows={rows} />)

    const valueEl = container.querySelector(".card-block__value")
    expect(valueEl).toBeInTheDocument()
    expect(valueEl).toHaveTextContent("true")
    expect(valueEl).toHaveClass("typography--semibold")
  })
})

// ===== Composition =====

describe("Card composition", () => {
  // 11.1
  it("[tag:card][tag:composition] should render full card with header, content, and footer segments", () => {
    const { container } = renderWithProviders(
      <Card>
        <CardHeader title="Title" subtitle="Subtitle" />
        <CardContent>
          <CardBlock type="key-value">
            <CardBlockLabel>Key</CardBlockLabel>
            <CardBlockValue>Value</CardBlockValue>
          </CardBlock>
        </CardContent>
        <CardFooter actions={[{ label: "Save" }]} />
      </Card>,
    )

    expect(container.querySelector("[data-slot='card']")).toBeInTheDocument()
    expect(container.querySelector("[data-slot='card-header']")).toBeInTheDocument()
    expect(container.querySelector("[data-slot='card-content']")).toBeInTheDocument()
    expect(container.querySelector("[data-slot='card-block']")).toBeInTheDocument()
    expect(container.querySelector("[data-slot='card-footer']")).toBeInTheDocument()
    expect(screen.getByText("Title")).toBeInTheDocument()
    expect(screen.getByText("Key")).toBeInTheDocument()
    expect(screen.getByText("Value")).toBeInTheDocument()
    expect(screen.getByText("Save")).toBeInTheDocument()
  })

  // 11.2
  it("[tag:card][tag:composition] should render multiple blocks with separators inside content", () => {
    const { container } = renderWithProviders(
      <Card>
        <CardContent>
          <CardBlock type="key-value" hasSeparator>
            <CardBlockLabel>A</CardBlockLabel>
            <CardBlockValue>1</CardBlockValue>
          </CardBlock>
          <CardBlock type="key-value" hasSeparator>
            <CardBlockLabel>B</CardBlockLabel>
            <CardBlockValue>2</CardBlockValue>
          </CardBlock>
          <CardBlock type="key-value">
            <CardBlockLabel>C</CardBlockLabel>
            <CardBlockValue>3</CardBlockValue>
          </CardBlock>
        </CardContent>
      </Card>,
    )

    const blocks = container.querySelectorAll("[data-slot='card-block']")
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toHaveClass("card-block--separator")
    expect(blocks[1]).toHaveClass("card-block--separator")
    expect(blocks[2]).not.toHaveClass("card-block--separator")
  })

  // 11.3
  it("[tag:card][tag:composition] should render metric blocks inside CardContentLayout grid", () => {
    const { container } = renderWithProviders(
      <Card>
        <CardContentLayout columns={3}>
          <CardBlock type="metric" hasSideSeparator>
            <CardBlockMetric value="100" subtitle="Files" />
          </CardBlock>
          <CardBlock type="metric" hasSideSeparator>
            <CardBlockMetric value="50" units="GB" subtitle="Size" />
          </CardBlock>
          <CardBlock type="metric">
            <CardBlockMetric value="99.9%" subtitle="Uptime" />
          </CardBlock>
        </CardContentLayout>
      </Card>,
    )

    const layout = container.querySelector("[data-slot='card-content-layout']") as HTMLElement
    expect(layout).toBeInTheDocument()
    expect(layout.style.gridTemplateColumns).toBe("repeat(3, 1fr)")

    const blocks = container.querySelectorAll("[data-slot='card-block']")
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toHaveClass("card-block--side-separator")
    expect(blocks[2]).not.toHaveClass("card-block--side-separator")
  })

  // 11.4
  it("[tag:card][tag:composition][tag:clickable] should fire both card and block onClick due to event bubbling", () => {
    const cardClick = vi.fn()
    const blockClick = vi.fn()

    const { container } = renderWithProviders(
      <Card onClick={cardClick}>
        <CardContent>
          <CardBlock onClick={blockClick}>
            <span>inner</span>
          </CardBlock>
        </CardContent>
      </Card>,
    )

    const block = container.querySelector("[data-slot='card-block']")!
    fireEvent.click(block)

    expect(blockClick).toHaveBeenCalledOnce()
    // card onClick also fires due to event bubbling — this is expected DOM behavior
    expect(cardClick).toHaveBeenCalledOnce()
  })
})
