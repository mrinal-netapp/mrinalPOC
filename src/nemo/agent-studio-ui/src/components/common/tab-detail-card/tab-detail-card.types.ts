import type { VariantProps } from "class-variance-authority"
import type { ReactNode } from "react"

import type { TabItem } from "@/ui-lib/base-components/tab/tab"
import { tabVariants } from "@/ui-lib/base-components/tab/tab.variants"

type TabDetailPanel = {
  tabId: string
  content: ReactNode
  panelClassName?: string
}

type TabDetailCardProps = {
  title: string
  // Optional. Mirrors `CardHeaderProps.subtitle`, which is also optional —
  // forcing callers to pass an empty string here would diverge from the rest
  // of the design system (see e.g. confirm-dialog and other CardHeader
  // consumers that render title-only headers).
  subtitle?: string
  tabs: TabItem[]
  activeTabId?: string
  onTabChange?: (tabId: string) => void
  variant?: VariantProps<typeof tabVariants>["variant"]
  ariaLabel: string
  cardClassName?: string
  panels: TabDetailPanel[]
}

export type { TabDetailCardProps, TabDetailPanel }
