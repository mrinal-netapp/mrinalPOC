import type { KeyboardEvent, ReactElement } from "react"

import { cn } from "@/ui-lib/lib/utils"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { cardBlockVariants } from "./card.variants"
import type {
  CardBlockProps,
  CardBlockLabelProps,
  CardBlockValueProps,
  CardBlockMetricProps,
  CardBlockStatusProps,
  CardBlockKeyValueListProps,
  KeyValueRow,
} from "./card.types"
import "./card.scss"

function CardBlock({
  type,
  hasSeparator,
  hasSideSeparator,
  onClick,
  isDisabled,
  children,
  className,
}: CardBlockProps): ReactElement {
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
      data-slot="card-block"
      className={cn(
        cardBlockVariants({ type }),
        hasSeparator && "card-block--separator",
        hasSideSeparator && "card-block--side-separator",
        clickable && "card-block--clickable",
        isDisabled && "card-block--disabled",
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

// -- Helper sub-components --

function CardBlockLabel({ isEllipsis, children, className }: CardBlockLabelProps): ReactElement {
  return (
    <Typography fontSize="fs14" isEllipsis={isEllipsis} className={cn("card-block__label", className)}>
      {children}
    </Typography>
  )
}

function CardBlockValue({ isEllipsis, children, className }: CardBlockValueProps): ReactElement {
  return (
    <Typography fontSize="fs14" boldness="semibold" isEllipsis={isEllipsis} className={cn("card-block__value", className)}>
      {children}
    </Typography>
  )
}

function CardBlockMetric({
  value,
  units,
  valueSize = "fs32",
  valueType = "regular",
  unitSize = "fs16",
  unitType = "regular",
  icon,
  orientation = "horizontal",
  subtitle,
  className,
}: CardBlockMetricProps): ReactElement {
  return (
    <div className={cn("card-block-metric", `card-block-metric--${orientation}`, className)}>
      {icon && <div className="card-block-metric__icon">{icon}</div>}
      <div className="card-block-metric__content">
        <div className="card-block-metric__value-line">
          <Typography fontSize={valueSize} boldness={valueType} className="card-block-metric__value">
            {value}
          </Typography>
          {units && (
            <Typography fontSize={unitSize} boldness={unitType} className="card-block-metric__units">
              {units}
            </Typography>
          )}
        </div>
        {subtitle && (
          <Typography fontSize="fs14" className="card-block-metric__subtitle">
            {subtitle}
          </Typography>
        )}
      </div>
    </div>
  )
}

function CardBlockStatus({ status, children, className }: CardBlockStatusProps): ReactElement {
  return (
    <div className={cn("card-block__status", className)}>
      <span className={cn("card-block__status-dot", `card-block__status-dot--${status}`)} />
      {children}
    </div>
  )
}

function CardBlockKeyValueList({ rows, className }: CardBlockKeyValueListProps): ReactElement {
  return (
    <>
      {rows.map((row, idx) => (
        <CardBlock
          key={`${row.label}-${idx}`}
          type="key-value"
          hasSeparator={idx < rows.length - 1}
          className={className}
        >
          <CardBlockLabel isEllipsis>{row.label}</CardBlockLabel>
          {typeof row.value === "string" || typeof row.value === "number" || typeof row.value === "boolean"
            ? <CardBlockValue isEllipsis>{String(row.value)}</CardBlockValue>
            : row.value
          }
        </CardBlock>
      ))}
    </>
  )
}

export { CardBlock, CardBlockLabel, CardBlockValue, CardBlockMetric, CardBlockStatus, CardBlockKeyValueList }
export type {
  CardBlockProps,
  CardBlockLabelProps,
  CardBlockValueProps,
  CardBlockMetricProps,
  CardBlockStatusProps,
  CardBlockKeyValueListProps,
  KeyValueRow,
}
