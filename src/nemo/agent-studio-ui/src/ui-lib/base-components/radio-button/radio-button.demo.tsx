import React, { useState } from "react"

import { RadioButton, RadioGroup } from "./radio-button"
import "./radio-button.demo.scss"

const STATES = [
  "Unselected",
  "Selected",
  "Hover",
  "Disabled Off",
  "Disabled On",
  "Error",
  "Warning",
] as const

type VariantKey = "solid" | "table"
const VARIANTS: VariantKey[] = ["solid", "table"]

function RadioButtonRow({ variant }: { variant: VariantKey }): React.JSX.Element {
  const [selected, setSelected] = useState("")

  return (
    <>
      <div className="radio-demo__cell radio-demo__cell--label">
        {variant.charAt(0).toUpperCase() + variant.slice(1)}
      </div>

      {/* Unselected */}
      <div className="radio-demo__cell">
        <RadioGroup value={selected} onValueChange={(val) => setSelected(val as string)}>
          <RadioButton value={`${variant}-unselected`} variant={variant} />
        </RadioGroup>
      </div>

      {/* Selected */}
      <div className="radio-demo__cell">
        <RadioGroup value="on">
          <RadioButton value="on" variant={variant} />
        </RadioGroup>
      </div>

      {/* Hover */}
      <div className="radio-demo__cell radio-demo__cell--note">
        CSS :hover
      </div>

      {/* Disabled Off */}
      <div className="radio-demo__cell">
        <RadioGroup>
          <RadioButton value="disabled-off" variant={variant} isDisabled />
        </RadioGroup>
      </div>

      {/* Disabled On */}
      <div className="radio-demo__cell">
        <RadioGroup value="disabled-on" disabled>
          <RadioButton value="disabled-on" variant={variant} />
        </RadioGroup>
      </div>

      {/* Error */}
      <div className="radio-demo__cell">
        <RadioGroup>
          <RadioButton value="err-off" variant={variant} isError />
        </RadioGroup>
        <RadioGroup value="err-on">
          <RadioButton value="err-on" variant={variant} isError />
        </RadioGroup>
      </div>

      {/* Warning */}
      <div className="radio-demo__cell">
        <RadioGroup>
          <RadioButton value="warn-off" variant={variant} isWarning />
        </RadioGroup>
        <RadioGroup value="warn-on">
          <RadioButton value="warn-on" variant={variant} isWarning />
        </RadioGroup>
      </div>
    </>
  )
}

export default function RadioButtonDemo(): React.JSX.Element {
  const [groupValue, setGroupValue] = useState("option-1")
  const [unselectableValue, setUnselectableValue] = useState("opt-a")
  const [multiValue, setMultiValue] = useState<string[]>(["tag-1"])

  return (
    <div className="radio-demo">
      <h2 className="radio-demo__title">RadioButton Variants</h2>

      <div className="radio-demo__grid">
        <div className="radio-demo__cell radio-demo__cell--header" />
        {STATES.map((state) => (
          <div key={state} className="radio-demo__cell radio-demo__cell--header">
            {state}
          </div>
        ))}

        {VARIANTS.map((variant) => (
          <RadioButtonRow key={variant} variant={variant} />
        ))}
      </div>

      {/* Standard single-select */}
      <h2 className="radio-demo__title">Interactive RadioGroup</h2>

      <div className="radio-demo__interactive">
        <RadioGroup value={groupValue} onValueChange={(val) => setGroupValue(val as string)}>
          <label className="radio-demo__option">
            <RadioButton value="option-1" variant="solid" />
            <span>Option 1</span>
          </label>
          <label className="radio-demo__option">
            <RadioButton value="option-2" variant="solid" />
            <span>Option 2</span>
          </label>
          <label className="radio-demo__option">
            <RadioButton value="option-3" variant="solid" />
            <span>Option 3</span>
          </label>
        </RadioGroup>
        <p className="radio-demo__value">Selected: {groupValue}</p>
      </div>

      {/* canUnselect */}
      <h2 className="radio-demo__title">canUnselect (min=0)</h2>

      <div className="radio-demo__interactive">
        <p className="radio-demo__desc">
          Click a selected radio to clear it. min=0 allows empty selection.
        </p>
        <RadioGroup
          value={unselectableValue}
          onValueChange={(val) => setUnselectableValue(val as string)}
          min={0}
        >
          <label className="radio-demo__option">
            <RadioButton value="opt-a" variant="solid" canUnselect />
            <span>Option A</span>
          </label>
          <label className="radio-demo__option">
            <RadioButton value="opt-b" variant="solid" canUnselect />
            <span>Option B</span>
          </label>
          <label className="radio-demo__option">
            <RadioButton value="opt-c" variant="solid" canUnselect />
            <span>Option C</span>
          </label>
        </RadioGroup>
        <p className="radio-demo__value">
          Selected: {unselectableValue || "(none)"}
        </p>
      </div>

      {/* Multi-select with min/max */}
      <h2 className="radio-demo__title">Multi-select (min=1, max=3)</h2>

      <div className="radio-demo__interactive">
        <p className="radio-demo__desc">
          Select up to 3 items. At least 1 must remain selected.
        </p>
        <RadioGroup
          value={multiValue}
          onValueChange={(val) => setMultiValue(val as string[])}
          min={1}
          max={3}
        >
          {["tag-1", "tag-2", "tag-3", "tag-4", "tag-5"].map((tag) => (
            <label key={tag} className="radio-demo__option">
              <RadioButton value={tag} variant="solid" canUnselect />
              <span>{tag}</span>
            </label>
          ))}
        </RadioGroup>
        <p className="radio-demo__value">
          Selected: [{multiValue.join(", ")}]
        </p>
      </div>
    </div>
  )
}
