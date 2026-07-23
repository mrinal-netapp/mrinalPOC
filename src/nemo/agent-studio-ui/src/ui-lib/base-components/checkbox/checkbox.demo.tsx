import React, { useState } from "react"

import { Checkbox } from "./checkbox"
import "./checkbox.demo.scss"

const STATES = [
  "Unchecked",
  "Checked",
  "Indeterminate",
  "Hover",
  "Disabled Off",
  "Disabled On",
  "Error",
  "Warning",
] as const

type VariantKey = "solid" | "table"
const VARIANTS: VariantKey[] = ["solid", "table"]

function CheckboxRow({ variant }: { variant: VariantKey }): React.JSX.Element {
  const [unchecked, setUnchecked] = useState(false)
  const [checked, setChecked] = useState(true)
  const [indeterminate, setIndeterminate] = useState(false)
  const [errorOff, setErrorOff] = useState(false)
  const [errorOn, setErrorOn] = useState(true)
  const [warningOff, setWarningOff] = useState(false)
  const [warningOn, setWarningOn] = useState(true)

  return (
    <>
      <div className="checkbox-demo__cell checkbox-demo__cell--label">
        {variant.charAt(0).toUpperCase() + variant.slice(1)}
      </div>

      {/* Unchecked */}
      <div className="checkbox-demo__cell">
        <Checkbox
          variant={variant}
          checked={unchecked}
          onCheckedChange={(val) => setUnchecked(val)}
        />
      </div>

      {/* Checked */}
      <div className="checkbox-demo__cell">
        <Checkbox
          variant={variant}
          checked={checked}
          onCheckedChange={(val) => setChecked(val)}
        />
      </div>

      {/* Indeterminate */}
      <div className="checkbox-demo__cell">
        <Checkbox
          variant={variant}
          checked={false}
          indeterminate={!indeterminate}
          onCheckedChange={() => setIndeterminate((prev) => !prev)}
        />
      </div>

      {/* Hover */}
      <div className="checkbox-demo__cell checkbox-demo__cell--note">
        CSS :hover
      </div>

      {/* Disabled Off */}
      <div className="checkbox-demo__cell">
        <Checkbox variant={variant} checked={false} isDisabled />
      </div>

      {/* Disabled On */}
      <div className="checkbox-demo__cell">
        <Checkbox variant={variant} checked isDisabled />
      </div>

      {/* Error */}
      <div className="checkbox-demo__cell">
        <Checkbox variant={variant} checked={errorOff} onCheckedChange={(val) => setErrorOff(val)} isError />
        <Checkbox variant={variant} checked={errorOn} onCheckedChange={(val) => setErrorOn(val)} isError />
      </div>

      {/* Warning */}
      <div className="checkbox-demo__cell">
        <Checkbox variant={variant} checked={warningOff} onCheckedChange={(val) => setWarningOff(val)} isWarning />
        <Checkbox variant={variant} checked={warningOn} onCheckedChange={(val) => setWarningOn(val)} isWarning />
      </div>
    </>
  )
}

export default function CheckboxDemo(): React.JSX.Element {
  return (
    <div className="checkbox-demo">
      <h2 className="checkbox-demo__title">Checkbox Variants</h2>

      <div className="checkbox-demo__grid">
        {/* Header row */}
        <div className="checkbox-demo__cell checkbox-demo__cell--header" />
        {STATES.map((state) => (
          <div key={state} className="checkbox-demo__cell checkbox-demo__cell--header">
            {state}
          </div>
        ))}

        {VARIANTS.map((variant) => (
          <CheckboxRow key={variant} variant={variant} />
        ))}
      </div>
    </div>
  )
}
