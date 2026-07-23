import { useMemo, type ReactElement } from "react"
import { IconRefresh } from "@tabler/icons-react"

import { Typography } from "@/ui-lib/base-components/typography/typography"
import { Button } from "@/ui-lib/base-components/button/button"
import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp"
import { ACTIVITY_COLUMNS } from "./activity-panel.consts"
import type { ActivityPanelProps } from "./activity-panel.types"

function ActivityPanel({ events, onRefresh }: ActivityPanelProps): ReactElement {
  const columns = useMemo(() => ACTIVITY_COLUMNS, [])

  return (
    <div className="model-activity">
      <div className="model-activity__header">
        <Typography fontSize="fs16" boldness="semibold" Component="h2">
          Activity
        </Typography>
        <div className="model-activity__controls">
          <Button
            variant="flat"
            size="medium"
            label="Refresh"
            icon={<IconRefresh size={16} />}
            onClick={onRefresh}
          />
        </div>
      </div>

      <BaseTable
        data={events}
        columns={columns}
        options={{ enableColumnSorting: true }}
      />
    </div>
  )
}

export { ActivityPanel }
