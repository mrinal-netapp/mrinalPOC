import type { ReactElement } from "react"

import { Card } from "@/ui-lib/base-components/card/card"
import { CardContent } from "@/ui-lib/base-components/card/card.content"
import { CardBlock, CardBlockMetric } from "@/ui-lib/base-components/card/card.block"
import type { MetricsRowProps } from "./metrics-row.types"
import "./metrics-row.scss"

function MetricsRow({ metrics, className }: MetricsRowProps): ReactElement {
  return (
    <Card className={`metrics-row${className ? ` ${className}` : ""}`}>
      <CardContent>
        <div className="metrics-row__grid">
          {metrics.map((metric, idx) => (
            <CardBlock
              key={`${metric.subtitle}-${idx}`}
              type="metric"
              hasSideSeparator={idx < metrics.length - 1}
              className="metrics-row__tile"
            >
              <CardBlockMetric
                icon={metric.icon}
                value={metric.value}
                units={metric.units}
                subtitle={metric.subtitle}
                valueSize="fs32"
                orientation="horizontal"
              />
            </CardBlock>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

export { MetricsRow }
export type { MetricItem, MetricsRowProps } from "./metrics-row.types"
