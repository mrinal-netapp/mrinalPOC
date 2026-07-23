import type { ReactElement, ReactNode } from "react"
import type { VariantProps } from "class-variance-authority"

import { cn } from "@/ui-lib/lib/utils"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { spinnerVariants } from "./spinner.variants"
import "./spinner.scss"

interface SpinnerProps {
  size?: VariantProps<typeof spinnerVariants>["size"]
  icon?: ReactNode
  isDisabled?: boolean
  isGrey?: boolean
  title?: string
  description?: string
  className?: string
}

function Spinner({
  size = "inline",
  icon,
  isDisabled = false,
  isGrey = false,
  title,
  description,
  className,
}: SpinnerProps): ReactElement {
  const hasDetails = title !== undefined || description !== undefined
  const isFullScreen = size === "fullScreen"

  const spinning = icon !== undefined
    ? <span className="spinner__svg">{icon}</span>
    : (
      // 270-degree arc: viewBox 44, r=18, circumference≈113.1 → 75% dash / 25% gap
      <svg className="spinner__svg" viewBox="0 0 44 44">
        <circle className="spinner__circle" cx="22" cy="22" r="18" strokeDasharray="84.82 28.27" />
      </svg>
    )

  const details = hasDetails && (
    <div className="spinner__details">
      {title !== undefined && (
        <Typography fontSize="fs16" boldness="semibold">
          {title}
        </Typography>
      )}
      {description !== undefined && (
        <Typography fontSize="fs14" boldness="regular">
          {description}
        </Typography>
      )}
    </div>
  )

  const content = isFullScreen && hasDetails
    ? <div className="spinner__card">{spinning}{details}</div>
    : <>{spinning}{details}</>

  return (
    <div
      role="status"
      aria-label={title ?? "Loading"}
      className={cn(
        spinnerVariants({ size }),
        isDisabled && "spinner--disabled",
        isGrey && "spinner--grey",
        hasDetails && "spinner--with-details",
        className,
      )}
    >
      {content}
    </div>
  )
}

export { Spinner }
export type { SpinnerProps }
