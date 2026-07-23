import type { ReactElement, ReactNode } from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { IconInfoCircle } from "@tabler/icons-react"

import { cn } from "@/ui-lib/lib/utils"
import { Button } from "@/ui-lib/base-components/button/button"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import "./tooltip.scss"

// -- Provider

type TooltipProviderProps = TooltipPrimitive.Provider.Props

function TooltipProvider({
  delay = 200,
  ...props
}: TooltipProviderProps): ReactElement {
  return <TooltipPrimitive.Provider delay={delay} {...props} />
}

// -- Tooltip (single encapsulated component)

interface TooltipProps {
  content: string | ReactNode
  trigger?: ReactElement
  side?: "top" | "right" | "bottom" | "left"
  sideOffset?: number
  className?: string
}

function Tooltip({
  content,
  trigger,
  side = "top",
  sideOffset = 8,
  className,
}: TooltipProps): ReactElement {
  const defaultTrigger = (
    <Button variant="icon" icon={<IconInfoCircle size={16} />} aria-label="More information" />
  )

  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger
        data-slot="tooltip-trigger"
        className={cn("tooltip__trigger", !trigger && "tooltip__trigger--icon")}
        render={trigger ?? defaultTrigger}
      />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner
          className="tooltip__positioner"
          side={side}
          sideOffset={sideOffset}
          align="center"
        >
          <TooltipPrimitive.Popup
            data-slot="tooltip-content"
            className={cn("tooltip__popup", className)}
          >
            {typeof content === "string" ? (
              <Typography Component="span" fontSize="fs13" boldness="regular">
                {content}
              </Typography>
            ) : (
              content
            )}
            <TooltipPrimitive.Arrow className="tooltip__arrow" />
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

export { TooltipProvider, Tooltip }
export type { TooltipProviderProps, TooltipProps }
