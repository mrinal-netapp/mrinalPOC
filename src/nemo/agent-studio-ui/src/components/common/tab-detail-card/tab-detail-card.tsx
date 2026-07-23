import type { ReactElement } from "react"

import { Card } from "@/ui-lib/base-components/card/card"
import { CardHeader } from "@/ui-lib/base-components/card/card.header"
import { CardContent } from "@/ui-lib/base-components/card/card.content"
import { TabGroup, TabContent } from "@/ui-lib/base-components/tab/tab-group"
import { cn } from "@/ui-lib/lib/utils"
import type { TabDetailCardProps } from "./tab-detail-card.types"
import "./tab-detail-card.scss"

function TabDetailCard({
  title,
  subtitle,
  tabs,
  activeTabId,
  onTabChange,
  variant = "general",
  ariaLabel,
  cardClassName,
  panels,
}: TabDetailCardProps): ReactElement {
  return (
    <Card className={cardClassName}>
      <CardHeader title={title} subtitle={subtitle} hasSeparator />
      <CardContent>
        <div className="tab-detail-card__content">
          <TabGroup
            tabs={tabs}
            activeTabId={activeTabId}
            onTabChange={onTabChange}
            variant={variant}
            ariaLabel={ariaLabel}
            className="tab-detail-card__tabs"
          >
            {panels.map((panel) => (
              <TabContent key={panel.tabId} tabId={panel.tabId}>
                <div className={cn("tab-detail-card__tab-body", panel.panelClassName)}>
                  {panel.content}
                </div>
              </TabContent>
            ))}
          </TabGroup>
        </div>
      </CardContent>
    </Card>
  )
}

export { TabDetailCard }
export type { TabDetailCardProps, TabDetailPanel } from "./tab-detail-card.types"
