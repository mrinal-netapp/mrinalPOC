import type { ReactElement } from "react"

import { cn } from "@/ui-lib/lib/utils"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import type { CardHeaderProps } from "./card.types"
import "./card.scss"

function CardHeader({
  icon,
  title,
  subtitle,
  orientation = "horizontal",
  actions,
  hasSeparator,
  className,
}: CardHeaderProps): ReactElement {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "card-header",
        hasSeparator && "card-header--separator",
        className,
      )}
    >
      <div
        className={cn(
          "card-header__left",
          orientation === "vertical" && "card-header__left--vertical",
        )}
      >
        {icon && <div className="card-header__icon">{icon}</div>}
        <div className="card-header__text">
          <Typography fontSize="fs16" boldness="semibold" className="card-header__title">
            {title}
          </Typography>
          {subtitle && (
            <Typography fontSize="fs14" className="card-header__subtitle">
              {subtitle}
            </Typography>
          )}
        </div>
      </div>
      {actions && actions.length > 0 && (
        <div className="card-header__actions">{actions.slice(0, 2)}</div>
      )}
    </div>
  )
}

export { CardHeader }
export type { CardHeaderProps }
