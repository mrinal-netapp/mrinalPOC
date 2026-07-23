import type { KeyboardEvent, ReactElement } from "react"

import { cn } from "@/ui-lib/lib/utils"
import type { CardProps } from "./card.types"
import "./card.scss"

function Card({ children, className, onClick, isDisabled }: CardProps): ReactElement {
  const clickable = !!onClick
  const interactive = clickable && !isDisabled

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return

    if (event.key === "Enter") {
      event.preventDefault()
      onClick!()
    }

    if (event.key === " ") {
      event.preventDefault()
    }
  }

  function handleKeyUp(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return

    if (event.key === " ") {
      onClick!()
    }
  }

  return (
    <div
      data-slot="card"
      className={cn(
        "card",
        clickable && "card--clickable",
        isDisabled && "card--disabled",
        className,
      )}
      onClick={interactive ? onClick : undefined}
      onKeyDown={interactive ? handleKeyDown : undefined}
      onKeyUp={interactive ? handleKeyUp : undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-disabled={isDisabled || undefined}
    >
      {children}
    </div>
  )
}

export { Card }
export type { CardProps }
