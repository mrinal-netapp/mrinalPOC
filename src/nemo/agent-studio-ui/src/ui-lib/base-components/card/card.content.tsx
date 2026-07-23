import type { ReactElement } from "react"

import { cn } from "@/ui-lib/lib/utils"
import type { CardContentProps } from "./card.types"
import "./card.scss"

function CardContent({ children, className }: CardContentProps): ReactElement {
  return (
    <div data-slot="card-content" className={cn("card-content", className)}>
      {children}
    </div>
  )
}

export { CardContent }
export type { CardContentProps }
