import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
  IconLoader2,
} from "@tabler/icons-react"

import type { StatusVisualConfig } from "@/components/data-source/utils/data-source.utils"

import type { ToolStatus } from "../toolset-list.types"

export const TOOLSET_STATUS_ICON_MAP: Record<ToolStatus, StatusVisualConfig> = {
  healthy: { type: "icon", Icon: IconCircleCheck, color: "var(--notification-success)" },
  unhealthy: { type: "icon", Icon: IconCircleX, color: "var(--notification-error)" },
  unknown: { type: "icon", Icon: IconAlertTriangle, color: "var(--notification-warning)" },
  deploying: { type: "icon", Icon: IconLoader2, color: "var(--notification-information)" },
}
