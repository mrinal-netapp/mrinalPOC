import { type CSSProperties, type ReactElement, type ReactNode } from "react"
import { IconX } from "@tabler/icons-react"

import {
  Dialog,
  DialogPopup,
  DialogTitle,
} from "@/ui-lib/base-components/dialog/dialog"
import type { DialogOpenChangeReason } from "@/ui-lib/base-components/dialog/dialog.types"
import { Button } from "@/ui-lib/base-components/button/button"
import { cn } from "@/ui-lib/lib/utils"
import "./side-panel.scss"

interface SidePanelProps {
  open: boolean
  onOpenChange: (open: boolean, event?: Event, reason?: DialogOpenChangeReason) => void
  title: ReactNode
  headerAction?: ReactNode
  footer?: ReactNode
  children: ReactNode
  width?: number
  className?: string
  bodyClassName?: string
}

function SidePanel({
  open,
  onOpenChange,
  title,
  headerAction,
  footer,
  children,
  width = 400,
  className,
  bodyClassName,
}: SidePanelProps): ReactElement {
  const portalContainer = typeof document === "undefined" ? null : document.body

  return (
    <Dialog open={open} onOpenChange={onOpenChange} container={portalContainer}>
      <DialogPopup
        showCloseButton={false}
        className={cn("side-panel", className)}
        style={{ "--side-panel-width": `${width}px` } as CSSProperties}
      >
        <section className="side-panel__inner">
          <header className="side-panel__header">
            <DialogTitle className="side-panel__title">{title}</DialogTitle>
            {headerAction !== undefined && (
              <div className="side-panel__header-action">{headerAction}</div>
            )}
            <Button
              variant="icon"
              size="medium"
              icon={<IconX size={20} />}
              aria-label="Close"
              className="side-panel__close"
              onClick={() => onOpenChange(false)}
            />
          </header>

          <div className={cn("side-panel__body", bodyClassName)}>{children}</div>

          {footer !== undefined && (
            <footer className="side-panel__footer">{footer}</footer>
          )}
        </section>
      </DialogPopup>
    </Dialog>
  )
}

export { SidePanel }
export type { SidePanelProps }
