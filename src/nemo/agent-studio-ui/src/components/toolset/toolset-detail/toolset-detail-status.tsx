import type { ReactElement } from "react"
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
  IconLoader2,
} from "@tabler/icons-react"

type ToolsetSummaryStatusPresentation = {
  icon: ReactElement
  className: string
}

function getToolsetSummaryStatusPresentation(status: string): ToolsetSummaryStatusPresentation {
  const normalized = status.trim().toLowerCase()

  if (normalized === "healthy" || normalized === "success" || normalized === "active") {
    return {
      icon: <IconCircleCheck size={16} />,
      className: "toolset-detail__status--healthy",
    }
  }

  if (normalized === "unhealthy" || normalized === "error" || normalized === "failed") {
    return {
      icon: <IconCircleX size={16} />,
      className: "toolset-detail__status--unhealthy",
    }
  }

  if (normalized === "deploying" || normalized === "provisioning") {
    return {
      icon: <IconLoader2 size={16} />,
      className: "toolset-detail__status--deploying",
    }
  }

  return {
    icon: <IconAlertTriangle size={16} />,
    className: "toolset-detail__status--warning",
  }
}

export { getToolsetSummaryStatusPresentation }
export type { ToolsetSummaryStatusPresentation }
