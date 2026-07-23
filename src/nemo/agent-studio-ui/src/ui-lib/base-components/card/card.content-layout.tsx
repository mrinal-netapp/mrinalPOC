import type { CSSProperties, ReactElement } from "react"

import { cn } from "@/ui-lib/lib/utils"
import type { CardContentLayoutProps } from "./card.types"
import "./card.scss"

function CardContentLayout({ columns, children, className }: CardContentLayoutProps): ReactElement {
  const cols = Math.max(1, columns)
  const style: CSSProperties = {
    gridTemplateColumns: `repeat(${cols}, 1fr)`,
  }

  return (
    <div data-slot="card-content-layout" className={cn("card-content-layout", className)} style={style}>
      {children}
    </div>
  )
}

export { CardContentLayout }
export type { CardContentLayoutProps }
