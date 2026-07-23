import { useCallback, useId, useMemo, useRef, useState } from "react"
import type { ChangeEvent, KeyboardEvent, ReactElement } from "react"
import type { VariantProps } from "class-variance-authority"
import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@/ui-lib/lib/utils"
import { Input } from "@/ui-lib/base-components/input/input"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { sliderVariants } from "./slider.variants"
import "./slider.scss"

interface SliderProps {
  /** Applied to the wrapper element for DOM targeting. */
  id?: string
  /** Id of an external label element; forwarded to the slider root via aria-labelledby. */
  ariaLabelledBy?: string
  value?: number | readonly number[]
  defaultValue?: number | readonly number[]
  onValueChange?: (value: number | readonly number[], eventDetails: SliderPrimitive.Root.ChangeEventDetails) => void
  onValueCommitted?: (value: number | readonly number[], eventDetails: SliderPrimitive.Root.CommitEventDetails) => void
  min?: number
  max?: number
  step?: number
  isDisabled?: boolean
  orientation?: "horizontal" | "vertical"
  size?: VariantProps<typeof sliderVariants>["size"]
  label?: string
  className?: string
  /** Shows min and max values inline, flanking the slider. Shortens the track to make room. */
  isShowLimits?: boolean
  /** Shows the current value above the slider thumb. */
  isShowCurrent?: boolean
  /** When isShowCurrent is true, makes the current value display an editable input. Values are clamped to min/max. */
  isEditInput?: boolean
}

function clamp(val: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, val))
}

function Slider({
  id,
  ariaLabelledBy,
  value,
  defaultValue,
  onValueChange,
  onValueCommitted,
  min = 0,
  max = 100,
  step = 1,
  isDisabled = false,
  orientation = "horizontal",
  size = "medium",
  label,
  className,
  isShowLimits = false,
  isShowCurrent = false,
  isEditInput = false,
}: SliderProps): ReactElement {
  const autoId = useId()
  const labelId = `${autoId}-label`
  const isControlled = value !== undefined

  const values = useMemo(() => {
    if (value !== undefined) return Array.isArray(value) ? value : [value]
    if (defaultValue !== undefined) return Array.isArray(defaultValue) ? defaultValue : [defaultValue]
    return [min]
  }, [value, defaultValue, min])

  // Internal value for uncontrolled mode, kept in sync via onValueChange
  const [internalValues, setInternalValues] = useState<readonly number[]>(values)

  // Derive currentValues with clamping so dynamic min/max changes are handled without an effect
  const currentValues = useMemo(() => {
    const raw = isControlled ? values : internalValues
    return raw.map((v) => clamp(v as number, min, max))
  }, [isControlled, values, internalValues, min, max])

  const handleValueChange = useCallback(
    (val: number | readonly number[], details: SliderPrimitive.Root.ChangeEventDetails) => {
      const arr = Array.isArray(val) ? val : [val]
      setInternalValues(arr)
      onValueChange?.(val, details)
    },
    [onValueChange],
  )

  // Current-value input state (for isEditInput)
  const [inputDraft, setInputDraft] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Escape sets draft to null, but blur fires before React re-renders,
  // so commitInputValue still sees the stale draft. This ref lets the
  // blur handler skip the commit when the dismissal was intentional.
  const skipCommitRef = useRef(false)

  // When isShowCurrent is on, we always track value internally so the display/input stay in sync
  const needsInternalTracking = isShowCurrent

  const primaryValue = currentValues[0] as number

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>): void => {
    setInputDraft(e.target.value)
  }

  const commitInputValue = useCallback((): void => {
    if (skipCommitRef.current) {
      skipCommitRef.current = false
      return
    }
    if (inputDraft === null) return

    const parsed = Number(inputDraft)
    if (Number.isNaN(parsed)) {
      setInputDraft(null)
      return
    }

    const clamped = clamp(parsed, min, max)
    const newValues = currentValues.length > 1
      ? [clamped, ...currentValues.slice(1)]
      : [clamped]

    setInternalValues(newValues)
    onValueChange?.(
      currentValues.length > 1 ? newValues : clamped,
      {} as SliderPrimitive.Root.ChangeEventDetails,
    )
    setInputDraft(null)
  }, [inputDraft, min, max, currentValues, onValueChange])

  const handleInputKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      commitInputValue()
      inputRef.current?.blur()
    } else if (e.key === "Escape") {
      skipCommitRef.current = true
      setInputDraft(null)
      inputRef.current?.blur()
    }
  }

  const displayValue = inputDraft ?? String(primaryValue)

  // Auto-size the input width based on content length
  const inputWidth = Math.max(2, displayValue.length) + 1

  return (
    <div id={id} className={cn(sliderVariants({ orientation, size }), isShowLimits && "slider--with-limits", className)}>
      {label !== undefined && (
        <Typography
          Component="label"
          id={labelId}
          fontSize="fs14"
          boldness="regular"
          className="slider__label"
        >
          {label}
        </Typography>
      )}

      {isShowCurrent && (
        <div className="slider__current">
          <Input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            className={cn("slider__current-input", !isEditInput && "slider__current-input--readonly")}
            value={displayValue}
            readOnly={!isEditInput}
            tabIndex={isEditInput ? 0 : -1}
            onChange={handleInputChange}
            onBlur={commitInputValue}
            onKeyDown={handleInputKeyDown}
            isDisabled={isDisabled}
            style={{ width: `${inputWidth}ch` }}
            aria-label="Current slider value"
          />
        </div>
      )}

      <div className="slider__track-row">
        {isShowLimits && (
          <Typography
            Component="span"
            fontSize="fs14"
            boldness="regular"
            className="slider__limit slider__limit--min"
          >
            {min}
          </Typography>
        )}

        <SliderPrimitive.Root
          data-slot="slider"
          aria-labelledby={[label !== undefined ? labelId : undefined, ariaLabelledBy].filter(Boolean).join(" ") || undefined}
          {...(needsInternalTracking
            ? { value: currentValues.length === 1 ? currentValues[0] : currentValues }
            : { value, defaultValue }
          )}
          onValueChange={handleValueChange}
          onValueCommitted={onValueCommitted}
          min={min}
          max={max}
          step={step}
          disabled={isDisabled}
          orientation={orientation}
          className="slider__root"
        >
          <SliderPrimitive.Control className="slider__control">
            <SliderPrimitive.Track className="slider__track">
              <SliderPrimitive.Indicator className="slider__indicator" />
              {currentValues.map((_, index) => (
                <SliderPrimitive.Thumb
                  key={index}
                  index={index}
                  aria-label={currentValues.length > 1 ? (index === 0 ? "Minimum value" : "Maximum value") : undefined}
                  className="slider__thumb"
                />
              ))}
            </SliderPrimitive.Track>
          </SliderPrimitive.Control>
        </SliderPrimitive.Root>

        {isShowLimits && (
          <Typography
            Component="span"
            fontSize="fs14"
            boldness="regular"
            className="slider__limit slider__limit--max"
          >
            {max}
          </Typography>
        )}
      </div>
    </div>
  )
}

export { Slider }
export type { SliderProps }
