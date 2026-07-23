import type { ReactElement, ReactNode } from "react"
import { Popover } from "@base-ui/react/popover"
import { IconInfoCircle } from "@tabler/icons-react"

import { cn } from "@/ui-lib/lib/utils"
import { useFloatingLayerZIndex } from "@/ui-lib/lib/floating-layer-context"
import { Button } from "@/ui-lib/base-components/button/button"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import "./info-popover.scss"

interface InfoPopoverProps {
  content: string | ReactNode
  trigger?: ReactElement
  side?: "top" | "right" | "bottom" | "left"
  sideOffset?: number
  className?: string
}

function InfoPopover({
  content,
  trigger,
  side = "top",
  sideOffset = 8,
  className,
}: InfoPopoverProps): ReactElement {
  const zIndex = useFloatingLayerZIndex()
  const defaultTrigger = (
    <Button variant="icon" icon={<IconInfoCircle size={16} />} aria-label="More information" />
  )

  return (
    <Popover.Root>
      <Popover.Trigger
        data-slot="info-popover-trigger"
        className={cn("info-popover__trigger", !trigger && "info-popover__trigger--icon")}
        openOnHover
        delay={200}
        nativeButton
        render={trigger ?? defaultTrigger}
      />
      <Popover.Portal>
        <Popover.Positioner
          className="info-popover__positioner"
          style={{ zIndex }}
          side={side}
          sideOffset={sideOffset}
          align="center"
        >
          <Popover.Popup
            data-slot="info-popover-content"
            className={cn("info-popover__popup", className)}
          >
            {typeof content === "string" ? (
              <Typography Component="span" fontSize="fs13" boldness="regular">
                {content}
              </Typography>
            ) : (
              content
            )}
            <Popover.Arrow className="info-popover__arrow" />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

export { InfoPopover }
export type { InfoPopoverProps }
