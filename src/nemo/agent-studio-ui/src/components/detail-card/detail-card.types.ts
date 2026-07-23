import type { ReactNode } from "react"

import type { TabItem } from "@/ui-lib/base-components/tab/tab"

type DetailCardRow = {
  label: string
  value: ReactNode
}

type DetailCardProps = {
  /** Rows always rendered inside the built-in "Details" tab. */
  rows: DetailCardRow[]
  /**
   * Additional tabs to show alongside the built-in "Details" tab.
   * Provide matching <TabContent tabId="..."> blocks via `children`.
   *
   * @example
   * <DetailCard
   *   rows={detailRows}
   *   extraTabs={[{ id: "cost-config", label: "Cost Configuration" }]}
   * >
   *   <TabContent tabId="cost-config">
   *     <CostConfigPanel />
   *   </TabContent>
   * </DetailCard>
   */
  extraTabs?: TabItem[]
  /** TabContent blocks for each entry in extraTabs. */
  children?: ReactNode
  className?: string
}

export type { DetailCardRow, DetailCardProps }
