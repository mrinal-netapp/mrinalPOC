import type { ActivityEvent } from "../../model-detail-page.types"

type ActivityPanelProps = {
  events: ActivityEvent[]
  onRefresh: () => void
}

export type { ActivityPanelProps }
