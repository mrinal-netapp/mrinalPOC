import { IconX } from "@tabler/icons-react"
import type { VariantProps } from "class-variance-authority"
import React, { type ReactElement } from "react"

import { cn } from "@/ui-lib/lib/utils"
import { Button } from "../button/button"
import { Typography } from "../typography/typography"
import { chipListVariants, chipVariants } from "./chip-list.variants"
import "./chip-list.scss"

// gap between chips — must stay in sync with the gap in chip-list.scss
const CHIP_GAP_PX = 4

const HIDDEN_STYLE: React.CSSProperties = {
  position: "absolute",
  visibility: "hidden",
  pointerEvents: "none",
}

// ---- Chip ----

interface ChipProps extends VariantProps<typeof chipVariants> {
  label: string
  onRemove?: () => void
  isDisabled?: boolean
  isRemovable?: boolean
  className?: string
  style?: React.CSSProperties
}

function Chip({ label, onRemove, isDisabled = false, isRemovable = true, className, style, type, color, size }: ChipProps): ReactElement {
  return (
    <div className={cn(chipVariants({ type, color, size }), !isRemovable && "chip--no-remove", className)} style={style}>
      <Typography
        fontSize="fs14"
        boldness="regular"
        isEllipsis
        isNowrap
        Component="span"
        color="var(--tag-1-text)"
        className="chip__label"
      >
        {label}
      </Typography>

      {isRemovable && (
        <Button
          variant="icon"
          size="small"
          render={<span />} // HTML spec forbids interactive content inside <button>; chips render inside the Combobox trigger
          nativeButton={false} // signals Base UI to use aria-disabled instead of the disabled attribute
          icon={<IconX className="chip__remove-icon" />}
          aria-label={`Remove ${label}`}
          tabIndex={-1}
          isDisabled={isDisabled}
          className={cn("chip__remove", isDisabled && "chip__remove--disabled")}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
            /* v8 ignore next -- @preserve */ // defence-in-depth against a caller bypassing Base UI's disabled contract
            if (!isDisabled) onRemove?.()
          }}
        />
      )}
    </div>
  )
}

// ---- ChipOverflow ----

interface ChipOverflowProps extends VariantProps<typeof chipVariants> {
  count: number
  className?: string
  style?: React.CSSProperties
}

function ChipOverflow({ count, className, style, type, color, size }: ChipOverflowProps): ReactElement {
  return (
    <div
      className={cn(chipVariants({ type, color, size }), "chip--overflow", className)}
      style={style}
    >
      <Typography
        isNowrap
        Component="span"
        color="var(--tag-1-text)"
        className="chip__label"
      >
        +{count}
      </Typography>
    </div>
  )
}

// ---- useChipOverflow ----

function useChipOverflow(
  containerRef: React.RefObject<HTMLDivElement | null>,
  values: unknown[],
  gapPx: number,
): number {
  const [visibleCount, setVisibleCount] = React.useState(values.length)

  // stringify values to detect any change (label lengths affect chip widths)
  const valuesKey = values.map(String).join(",")

  React.useLayoutEffect(() => {
    const container = containerRef.current
    /* v8 ignore next -- @preserve */ // React guarantees containerRef.current is set before useLayoutEffect fires
    if (!container) return /* v8 ignore next -- @preserve */

    function compute(): void {
      if (!container) return /* v8 ignore next -- @preserve */ // container is captured from the outer closure; always non-null inside compute
      const containerWidth = container.clientWidth
      if (!containerWidth) return

      // container.children order: [chip0, chip1, ..., overflowBadge]
      const children = Array.from(container.children) as HTMLElement[]
      const overflowEl = children[children.length - 1]
      const chipEls = children.slice(0, -1)

      const overflowWidth = (overflowEl?.offsetWidth ?? 50) + gapPx /* v8 ignore next -- @preserve */ // overflowEl is always defined — ChipOverflow is unconditionally rendered as the last child

      let usedWidth = 0
      let count = 0

      for (let i = 0; i < chipEls.length; i++) {
        const addedWidth = (i > 0 ? gapPx : 0) + chipEls[i].offsetWidth
        const hasMore = i < chipEls.length - 1
        const spaceNeeded = usedWidth + addedWidth + (hasMore ? overflowWidth : 0)

        if (spaceNeeded > containerWidth) break
        usedWidth += addedWidth
        count++
      }

      const next = Math.min(values.length, Math.max(1, count))
      setVisibleCount((prev) => (prev === next ? prev : next))
    }

    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(container)
    return () => ro.disconnect()
    // containerRef is stable (created by useRef) so it's safe to omit from deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valuesKey, gapPx])

  return visibleCount
}

// ---- ChipList ----

interface ChipListProps extends VariantProps<typeof chipListVariants> {
  values: unknown[]
  getLabel: (value: unknown) => string
  onRemove?: (value: unknown) => void
  isRemovable?: boolean
  isDisabled: boolean
  gapPx?: number
}

function ChipList({
  values,
  getLabel,
  onRemove,
  isRemovable = true,
  isDisabled,
  orientation,
  gapPx = CHIP_GAP_PX,
}: ChipListProps): ReactElement {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const visibleCount = useChipOverflow(containerRef, values, gapPx)

  const hiddenCount = values.length - visibleCount

  return (
    <div ref={containerRef} className={chipListVariants({ orientation })}>
      {values.map((v, i) => {
        const isHidden = i >= visibleCount

        return (
          <Chip
            key={String(v)}
            label={getLabel(v)}
            isRemovable={isRemovable}
            onRemove={() => onRemove?.(v)}
            isDisabled={isDisabled}
            style={isHidden ? HIDDEN_STYLE : undefined}
          />
        )
      })}

      {/* Always in DOM so its offsetWidth is measurable; hidden via absolute when not needed */}
      <ChipOverflow
        count={hiddenCount > 0 ? hiddenCount : 0}
        style={hiddenCount === 0 ? HIDDEN_STYLE : undefined}
      />
    </div>
  )
}

export { Chip, ChipList, ChipOverflow }
export type { ChipListProps, ChipOverflowProps, ChipProps }
