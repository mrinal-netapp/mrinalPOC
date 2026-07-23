import type { ReactElement } from "react"
import { Toaster as SonnerToaster, type ToasterProps } from "sonner"
import {
  IconCircleCheck,
  IconInfoCircle,
  IconAlertTriangle,
  IconAlertOctagon,
  IconLoader,
} from "@tabler/icons-react"

import { cn } from "@/ui-lib/lib/utils"
import "./toast.scss"

const ICON_SIZE = 16

interface SonnerProps extends ToasterProps {
  className?: string
}

function Toaster({ className, ...props }: SonnerProps): ReactElement {
  return (
    <div data-slot="sonner" className={cn("sonner-toaster", className)}>
      <SonnerToaster
        icons={{
          success: <IconCircleCheck size={ICON_SIZE} />,
          info: <IconInfoCircle size={ICON_SIZE} />,
          warning: <IconAlertTriangle size={ICON_SIZE} />,
          error: <IconAlertOctagon size={ICON_SIZE} />,
          loading: <IconLoader size={ICON_SIZE} className="sonner-toaster__loading-icon" />,
        }}
        toastOptions={{
          classNames: {
            toast: "sonner-toaster__toast",
            title: "sonner-toaster__title",
            description: "sonner-toaster__description",
            actionButton: "sonner-toaster__action-button",
            cancelButton: "sonner-toaster__cancel-button",
            closeButton: "sonner-toaster__close-button",
            success: "sonner-toaster__toast--success",
            error: "sonner-toaster__toast--error",
            warning: "sonner-toaster__toast--warning",
            info: "sonner-toaster__toast--info",
          },
        }}
        {...props}
      />
    </div>
  )
}

export { Toaster }
export type { SonnerProps }
