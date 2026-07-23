// TODO(i18n): externalize these labels once the i18n bundle is wired up (I18-001).
export const DEFAULT_ADD_LABEL = "Add"
export const DEFAULT_CANCEL_LABEL = "Cancel"
export const DEFAULT_CLOSE_ARIA_LABEL = "Close dialog"

/**
 * Selector list used by the panel's Tab / Shift+Tab focus-trap to discover
 * every natively focusable descendant (A11Y-004). Excludes elements that
 * have explicitly opted out via `tabindex="-1"` and disabled form controls.
 */
export const FOCUSABLE_SELECTORS = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ")
