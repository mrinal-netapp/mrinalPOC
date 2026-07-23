import type { ReactNode } from "react"

type AddEntityFormProps = {
  /** Optional class applied to the root dialog container. */
  className?: string
  /** Whether the form is rendered. */
  open: boolean
  /** Header bar title, e.g. "Add model", "Add tool", "Add agent". */
  title: string
  /**
   * Optional entity heading shown above the form card, e.g. "Knowledge base".
   * Omit when the page header is self-explanatory and a second heading
   * would be redundant.
   */
  entityName?: string
  /**
   * Optional descriptive sentence shown below the entity heading.
   * Only rendered when entityName is also provided.
   */
  entityDescription?: string
  /**
   * Primary action label. Defaults to "Add".
   * Pass an explicit value when the action differs (e.g. "Save").
   */
  addLabel?: string
  /** Secondary action label. Defaults to "Cancel". */
  cancelLabel?: string
  /** Accessible label for the close icon button. Defaults to "Close dialog". */
  closeAriaLabel?: string
  /** Called when the primary action button is clicked. */
  onAdd: () => void
  /** Called when Cancel or the X button is clicked. */
  onCancel: () => void
  /**
   * Ordered content blocks rendered in the form body.
   * Null and undefined entries are silently dropped, so callers may
   * conditionally include sections without extra filtering.
   */
  sections?: ReactNode[]
}

export type { AddEntityFormProps }
