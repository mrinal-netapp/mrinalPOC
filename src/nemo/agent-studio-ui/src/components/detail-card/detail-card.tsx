import { useState, type ReactElement } from "react"

import { Card } from "@/ui-lib/base-components/card/card"
import { CardBlock, CardBlockLabel, CardBlockValue } from "@/ui-lib/base-components/card/card.block"
import { TabGroup, TabContent } from "@/ui-lib/base-components/tab/tab-group"
import type { TabItem } from "@/ui-lib/base-components/tab/tab"
import { DETAILS_TAB } from "./detail-card.consts"
import type { DetailCardProps } from "./detail-card.types"
import "./detail-card.scss"

function DetailCard({ rows, extraTabs, children, className }: DetailCardProps): ReactElement {
  const tabs: TabItem[] = [DETAILS_TAB, ...(extraTabs ?? [])]
  const [requestedActiveTabId, setRequestedActiveTabId] = useState<string>(DETAILS_TAB.id)

  // Re-derive the effective active tab on every render so that removing or
  // disabling the currently-selected extra tab can't leave the TabGroup with
  // a value that no longer matches any tab. Falls back to the built-in
  // Details tab, which is always present.
  const requestedTab = tabs.find((t) => t.id === requestedActiveTabId)
  const activeTabId = requestedTab && !requestedTab.isDisabled
    ? requestedActiveTabId
    : DETAILS_TAB.id

  return (
    <Card className={`detail-card${className ? ` ${className}` : ""}`}>
      <TabGroup
        tabs={tabs}
        variant="card"
        activeTabId={activeTabId}
        onTabChange={setRequestedActiveTabId}
        ariaLabel="Detail sections"
        className="detail-card__tabs"
      >
        {/* Built-in Details tab — always present */}
        <TabContent tabId={DETAILS_TAB.id}>
          <div className="detail-card__rows">
            {rows.map((row, idx) => (
              <CardBlock
                key={`${row.label}-${idx}`}
                type="key-value"
                hasSeparator={idx < rows.length - 1}
              >
                <CardBlockLabel>{row.label}</CardBlockLabel>
                <CardBlockValue>{row.value}</CardBlockValue>
              </CardBlock>
            ))}
          </div>
        </TabContent>

        {/* Extra tabs — content provided by the consumer via children */}
        {children}
      </TabGroup>
    </Card>
  )
}

export { DetailCard, TabContent }
export type { DetailCardRow, DetailCardProps } from "./detail-card.types"
