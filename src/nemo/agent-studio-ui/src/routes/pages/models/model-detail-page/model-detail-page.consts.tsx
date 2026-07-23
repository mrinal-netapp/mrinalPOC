import { IconAlertTriangle, IconCircleCheck, IconCircleX } from "@tabler/icons-react"

import type { ModelStatus } from "./model-detail-page.types"
import type { ModelStatusPresentation } from "./model-detail-page.types"

const STATUS_MAP: Record<ModelStatus, ModelStatusPresentation> = {
  healthy: {
    label: "Healthy",
    icon: <IconCircleCheck size={16} />,
    className: "model-detail__status--healthy",
  },
  warning: {
    label: "Warning",
    icon: <IconAlertTriangle size={16} />,
    className: "model-detail__status--warning",
  },
  error: {
    label: "Unhealthy",
    icon: <IconCircleX size={16} />,
    className: "model-detail__status--error",
  },
}

export { STATUS_MAP }
