import type { ReactElement } from "react"
import { cn } from "@/ui-lib/lib/utils"
import "./flashing-dots-loader.scss"

interface FlashingDotsLoaderProps {
  className?: string
  isGrey?: boolean
}

function FlashingDotsLoader({ className, isGrey = false }: FlashingDotsLoaderProps): ReactElement {
  return (
    <div role="status" aria-label="Loading" className={cn("flashing-dots-loader", className, isGrey && "grey")}>
      <div className="dot-flashing" />
      <div className="dot-flashing" />
      <div className="dot-flashing" />
    </div>
  )
}

export { FlashingDotsLoader }
export type { FlashingDotsLoaderProps }
