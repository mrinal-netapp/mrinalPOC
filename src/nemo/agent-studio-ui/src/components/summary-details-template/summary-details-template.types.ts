import type { ReactNode } from "react"

import type { BreadcrumbItem } from "@/ui-lib/base-components/breadcrumb/breadcrumb"
import type { TabItem } from "@/ui-lib/base-components/tab/tab"

/**
 * A single entry rendered inside the template's summary strip.
 * The `value` can be a primitive (string / number — styled by the template)
 * or any ReactNode (rendered as-is, e.g. for status badges or links).
 */
type SummaryField = {
  label: string
  value: ReactNode
}

/** `row` — all fields in one left-aligned strip; `split` — first field left, rest grouped on the right. */
type SummaryStripLayout = "row" | "split"

/**
 * A single tab: its button definition + the content to render when active.
 * Co-locating both in one object keeps tab metadata and its panel together;
 * nullish content intentionally renders the template placeholder.
 */
type TabPanel = {
  /** Tab button: id (stable), label, optional isDisabled. */
  tab: TabItem
  /**
   * Content rendered when this tab is active. Pass `null`/`undefined` to
   * render the template's built-in "Content for ..." placeholder (useful
   * while the feature is being built out).
   */
  content: ReactNode
}

type SummaryDetailsTemplateProps = {
  /** Page title rendered as an `<h1>` next to the action slot. */
  title: string
  /**
   * Breadcrumb trail rendered above the title. Omit (or pass `[]`) to hide
   * the trail entirely — typical for top-level entry points.
   */
  breadcrumbs?: BreadcrumbItem[]
  /**
   * Header actions rendered to the right of the title (Refresh, Edit,
   * `<DropdownMenu>`, etc.). Pass a fragment when you need more than one.
   */
  actions?: ReactNode
  /** Fields displayed in the summary strip below the header. */
  summaryFields: SummaryField[]
  /**
   * Summary strip layout. Use `split` when the first field (typically Name)
   * should sit on the left and the remaining fields align as a group on the right.
   */
  summaryStripLayout?: SummaryStripLayout
  /**
   * Each entry defines one tab button AND its content in a single object.
   * The first non-disabled tab is active by default; if every tab is
   * disabled the template falls back to the first tab. If a previously-
   * active tab becomes disabled at runtime, the template re-derives the
   * active id so the `<TabGroup>` never holds a stale value.
   */
  tabPanels: TabPanel[]
  /** Extra class appended to the template's root element. */
  className?: string
}

export type { SummaryField, SummaryDetailsTemplateProps, SummaryStripLayout, TabPanel }
