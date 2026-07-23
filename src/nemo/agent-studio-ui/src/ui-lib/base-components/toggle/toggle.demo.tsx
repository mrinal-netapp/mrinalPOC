import React, { useState } from "react"

import { Toggle } from "./toggle"
import "./toggle.demo.scss"

const STATES = [
  "Off",
  "On",
  "Hover",
  "Disabled Off",
  "Disabled On",
  "Error",
  "Warning",
  "Custom Colors",
  "With Icon",
] as const

const CheckIcon = (
  <svg viewBox="0 0 10 8" fill="none">
    <path d="M1 4L3.5 6.5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const CrossIcon = (
  <svg viewBox="0 0 8 8" fill="none">
    <path d="M1 1L7 7M7 1L1 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)

export default function ToggleDemo(): React.JSX.Element {
  const [offState, setOffState] = useState(false)
  const [onState, setOnState] = useState(true)
  const [errorOff, setErrorOff] = useState(false)
  const [errorOn, setErrorOn] = useState(true)
  const [warningOff, setWarningOff] = useState(false)
  const [warningOn, setWarningOn] = useState(true)
  const [customOff, setCustomOff] = useState(false)
  const [customOn, setCustomOn] = useState(true)
  const [iconToggle, setIconToggle] = useState(false)
  const [iconToggleOn, setIconToggleOn] = useState(true)

  return (
    <div className="toggle-demo">
      <h2 className="toggle-demo__title">Toggle States</h2>

      <div className="toggle-demo__grid">
        {/* Header row */}
        <div className="toggle-demo__cell toggle-demo__cell--header" />
        {STATES.map((state) => (
          <div key={state} className="toggle-demo__cell toggle-demo__cell--header">
            {state}
          </div>
        ))}

        {/* Single row — toggle has no size variants */}
        <div className="toggle-demo__cell toggle-demo__cell--label">Default</div>

        {/* Off */}
        <div className="toggle-demo__cell">
          <Toggle checked={offState} onCheckedChange={(val) => setOffState(val)} />
        </div>

        {/* On */}
        <div className="toggle-demo__cell">
          <Toggle checked={onState} onCheckedChange={(val) => setOnState(val)} />
        </div>

        {/* Hover */}
        <div className="toggle-demo__cell toggle-demo__cell--note">
          CSS :hover
        </div>

        {/* Disabled Off */}
        <div className="toggle-demo__cell">
          <Toggle checked={false} isDisabled />
        </div>

        {/* Disabled On */}
        <div className="toggle-demo__cell">
          <Toggle checked isDisabled />
        </div>

        {/* Error */}
        <div className="toggle-demo__cell">
          <Toggle checked={errorOff} onCheckedChange={(val) => setErrorOff(val)} isError />
          <Toggle checked={errorOn} onCheckedChange={(val) => setErrorOn(val)} isError />
        </div>

        {/* Warning */}
        <div className="toggle-demo__cell">
          <Toggle checked={warningOff} onCheckedChange={(val) => setWarningOff(val)} isWarning />
          <Toggle checked={warningOn} onCheckedChange={(val) => setWarningOn(val)} isWarning />
        </div>

        {/* Custom Colors */}
        <div className="toggle-demo__cell">
          <Toggle
            checked={customOff}
            onCheckedChange={(val) => setCustomOff(val)}
            colorOn="#10b981"
            colorOff="#f59e0b"
          />
          <Toggle
            checked={customOn}
            onCheckedChange={(val) => setCustomOn(val)}
            colorOn="#8b5cf6"
            colorOff="#ef4444"
          />
        </div>

        {/* With Icon */}
        <div className="toggle-demo__cell">
          <Toggle
            checked={iconToggle}
            onCheckedChange={(val) => setIconToggle(val)}
            icon={iconToggle ? CheckIcon : CrossIcon}
            iconColorOn="#10b981"
            iconColorOff="#ef4444"
          />
          <Toggle
            checked={iconToggleOn}
            onCheckedChange={(val) => setIconToggleOn(val)}
            icon={iconToggleOn ? CheckIcon : CrossIcon}
            iconColorOn="#10b981"
            iconColorOff="#ef4444"
          />
        </div>
      </div>
    </div>
  )
}
