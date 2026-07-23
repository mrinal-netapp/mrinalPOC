import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useRef,
  type ReactElement,
} from "react"
import { IconX } from "@tabler/icons-react"

import { cn } from "@/ui-lib/lib/utils"
import { Button } from "@/ui-lib/base-components/button/button"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { Card } from "@/ui-lib/base-components/card/card"
import { CardContent } from "@/ui-lib/base-components/card/card.content"
import { CardBlock } from "@/ui-lib/base-components/card/card.block"
import {
  DEFAULT_ADD_LABEL,
  DEFAULT_CANCEL_LABEL,
  DEFAULT_CLOSE_ARIA_LABEL,
  FOCUSABLE_SELECTORS,
} from "./add-entity-form.consts"
import type { AddEntityFormProps } from "./add-entity-form.types"
import "./add-entity-form.scss"

function AddEntityForm({
  className,
  open,
  title,
  entityName,
  entityDescription,
  addLabel,
  cancelLabel = DEFAULT_CANCEL_LABEL,
  closeAriaLabel = DEFAULT_CLOSE_ARIA_LABEL,
  onAdd,
  onCancel,
  sections,
}: AddEntityFormProps): ReactElement | null {
  /*
   * Children.toArray normalizes the sections list (drops null/undefined,
   * flattens fragments) AND preserves caller-supplied keys on React
   * elements. We therefore prefer the caller's key when present and only
   * fall back to an index-based key for primitives or unkeyed elements,
   * so prepending/removing a section no longer remounts the others.
   */
  const resolvedSections = Children.toArray(sections)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<Element | null>(null)

  /*
   * A11Y-001 — Dialog semantics. The form behaves as a modal dialog: it
   * traps focus, dismisses on Escape, and overlays the route. To let
   * assistive tech announce it correctly the root needs role="dialog",
   * aria-modal, and an aria-labelledby pointing at a stable id on the
   * title. We mirror that with aria-describedby when an entity-description
   * paragraph is rendered, so screen readers can also announce the help
   * text after the title. `useId` produces SSR-safe unique ids.
   */
  const titleId = useId()
  const descriptionId = useId()
  /*
   * The description paragraph is rendered only when entityName is also
   * set (it lives inside the entity-heading block). Mirror that gate
   * here so aria-describedby never points at a node that wasn't
   * rendered — a dangling reference is worse than no attribute, since
   * screen readers can fall back to verbose URI announcements.
   */
  const hasName = entityName !== undefined && entityName !== ""
  const hasDescription =
    hasName && entityDescription !== undefined && entityDescription !== ""

  // Keep the latest onCancel reachable from inside the focus-management
  // effect without invalidating that effect on every parent re-render. If we
  // depended on onCancel directly, an unstable callback from the parent would
  // tear down the focus trap mid-interaction and re-focus the close button,
  // stealing focus from whatever input the user was typing in.
  const onCancelRef = useRef(onCancel)
  useEffect(() => {
    onCancelRef.current = onCancel
  }, [onCancel])

  /*
   * A11Y-004 — Focus management:
   *   • On open: capture the current focus owner, then move focus to the
   *     first focusable element inside the panel (close button).
   *   • On close: restore focus to the element that opened the form.
   *   • Tab / Shift+Tab: wrap around within the panel (focus trap).
   *   • Escape: dismiss the form (delegates to the latest onCancel).
   *
   * onCancel is intentionally NOT a dependency — we read it from a ref so a
   * new callback identity on parent re-render does not reset the focus trap.
   */
  useEffect(() => {
    const panel = panelRef.current
    if (!open || !panel) return

    triggerRef.current = document.activeElement

    const focusableElements = (): NodeListOf<HTMLElement> =>
      panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS)

    focusableElements()[0]?.focus()

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault()
        onCancelRef.current()
        return
      }

      if (e.key !== "Tab") return

      const elements = Array.from(focusableElements())
      if (elements.length === 0) return

      const first = elements[0]
      const last = elements[elements.length - 1]

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    panel.addEventListener("keydown", handleKeyDown)
    return () => {
      panel.removeEventListener("keydown", handleKeyDown)
      if (triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus()
      }
    }
  }, [open])

  if (!open) return null

  return (
    <div
      className={cn("add-entity-form", className)}
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={hasDescription ? descriptionId : undefined}
    >

      {/* Fixed Header */}
      <div className="add-entity-form__header">
        {/*
         * Top-bar title is the dialog's primary heading and the target of
         * aria-labelledby, so it must be the highest heading inside the
         * form. The optional entityName below it is a subordinate heading
         * (h2), matching the established full-page form pattern
         * (dataset/KB pages) and giving SR users a clean h1 -> h2 outline.
         */}
        <Typography
          id={titleId}
          className="add-entity-form__title"
          Component="h1"
          fontSize="fs20"
          boldness="semibold"
        >
          {title}
        </Typography>
        <button
          className="add-entity-form__close"
          type="button"
          onClick={onCancel}
          aria-label={closeAriaLabel}
        >
          <IconX size={20} />
        </button>
      </div>

      {/* Scrollable Body — mirrors the dataset/KB form layout pattern */}
      <div className="add-entity-form__body">
        <div className="add-entity-form__body-inner">

          {/*
           * Entity heading block is optional. Render it only when the
           * consumer actually provides a name — keeps the layout tight for
           * pages where the top-bar title already conveys what's being added.
           */}
          {hasName && (
            <div className="add-entity-form__header-block">
              <Typography Component="h2" fontSize="fs20" boldness="semibold">
                {entityName}
              </Typography>
              {hasDescription && (
                <Typography
                  id={descriptionId}
                  Component="p"
                  fontSize="fs14"
                  color="var(--text-secondary)"
                >
                  {entityDescription}
                </Typography>
              )}
            </div>
          )}

          {/*
           * Sections are wrapped in a Card + CardBlock so consumers get the
           * design-system's standard 24px/40px padding and separator rules
           * for free. Each section becomes a CardBlock; all but the last
           * carry a separator so dividers align with the design.
           */}
          {resolvedSections.length > 0 && (
            <Card className="add-entity-form__form-card">
              <CardContent>
                {resolvedSections.map((section, index) => {
                  const sectionKey =
                    isValidElement(section) && section.key !== null
                      ? section.key
                      : `section-${index}`
                  return (
                    <CardBlock
                      key={sectionKey}
                      type="description"
                      hasSeparator={index < resolvedSections.length - 1}
                    >
                      {section}
                    </CardBlock>
                  )
                })}
              </CardContent>
            </Card>
          )}

        </div>
      </div>

      {/*
       * Fixed Footer.
       *
       * Button order is intentionally Add → Cancel (primary first), matching
       * the design system spec for entity-creation flows. This differs from
       * the common OS convention (Cancel → primary) but is consistent across
       * every "Add X" form in this product.
       */}
      <div className="add-entity-form__footer">
        <Button variant="solid" size="large" label={addLabel ?? DEFAULT_ADD_LABEL} onClick={onAdd} />
        <Button variant="outline" size="large" label={cancelLabel} onClick={onCancel} />
      </div>

    </div>
  )
}

export { AddEntityForm }
export type { AddEntityFormProps }
