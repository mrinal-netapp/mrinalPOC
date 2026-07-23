import React, { useState } from "react"

import { RadioGroup } from "@/ui-lib/base-components/radio-button/radio-button"
import { SelectorWrapper } from "./selector-wrapper"
import "./selector-wrapper.demo.scss"

export default function SelectorWrapperDemo(): React.JSX.Element {
  const [cbChecked, setCbChecked] = useState(false)
  const [cbLabelOnly, setCbLabelOnly] = useState(true)
  const [cbError, setCbError] = useState(false)
  const [cbWarning, setCbWarning] = useState(true)
  const [toggleChecked, setToggleChecked] = useState(false)
  const [toggleLabelOnly, setToggleLabelOnly] = useState(true)
  const [radioValue, setRadioValue] = useState("opt-1")

  return (
    <div className="sw-demo">
      <h2 className="sw-demo__title">SelectorWrapper — Checkbox</h2>

      <div className="sw-demo__section">
        {/* Enabled with label + description */}
        <SelectorWrapper
          selectorType="checkbox"
          label="Accept terms"
          labelBoldness="semibold"
          description="You agree to our terms of service and privacy policy."
          selectorProps={{
            checked: cbChecked,
            onCheckedChange: (val) => setCbChecked(val),
          }}
        />

        {/* Label only */}
        <SelectorWrapper
          selectorType="checkbox"
          label="Remember me"
          labelBoldness="semibold"
          selectorProps={{
            checked: cbLabelOnly,
            onCheckedChange: (val) => setCbLabelOnly(val),
          }}
        />

        {/* Disabled */}
        <SelectorWrapper
          selectorType="checkbox"
          label="Disabled option"
          labelBoldness="semibold"
          description="This option cannot be changed."
          selectorProps={{
            checked: false,
            isDisabled: true,
          }}
        />

        {/* Disabled + checked */}
        <SelectorWrapper
          selectorType="checkbox"
          label="Locked selection"
          labelBoldness="semibold"
          description="This option is locked and enabled."
          selectorProps={{
            checked: true,
            isDisabled: true,
          }}
        />

        {/* Error */}
        <SelectorWrapper
          selectorType="checkbox"
          label="Required field"
          labelBoldness="semibold"
          description="You must accept to continue."
          selectorProps={{
            checked: cbError,
            onCheckedChange: (val) => setCbError(val),
            isError: true,
          }}
        />

        {/* Warning */}
        <SelectorWrapper
          selectorType="checkbox"
          label="Caution"
          labelBoldness="semibold"
          description="This action has side effects."
          selectorProps={{
            checked: cbWarning,
            onCheckedChange: (val) => setCbWarning(val),
            isWarning: true,
          }}
        />
      </div>

      <h2 className="sw-demo__title">SelectorWrapper — Radio Button</h2>

      <div className="sw-demo__section">
        <RadioGroup
          value={radioValue}
          onValueChange={(val) => setRadioValue(val as string)}
        >
          <SelectorWrapper
            selectorType="radioButton"
            label="Option 1"
            labelBoldness="semibold"
            description="First option with a helpful description."
            selectorProps={{ value: "opt-1" }}
          />
          <SelectorWrapper
            selectorType="radioButton"
            label="Option 2"
            labelBoldness="semibold"
            description="Second option with a helpful description."
            selectorProps={{ value: "opt-2" }}
          />
          <SelectorWrapper
            selectorType="radioButton"
            label="Disabled option"
            labelBoldness="semibold"
            description="This radio option cannot be selected."
            selectorProps={{ value: "opt-disabled", isDisabled: true }}
          />
        </RadioGroup>
      </div>

      <h2 className="sw-demo__title">SelectorWrapper — Toggle</h2>

      <div className="sw-demo__section">
        {/* Enabled with label + description */}
        <SelectorWrapper
          selectorType="toggle"
          label="Notifications"
          labelBoldness="semibold"
          description="Receive email notifications for important updates."
          selectorProps={{
            checked: toggleChecked,
            onCheckedChange: (val) => setToggleChecked(val),
          }}
        />

        {/* Label only */}
        <SelectorWrapper
          selectorType="toggle"
          label="Dark mode"
          labelBoldness="semibold"
          selectorProps={{
            checked: toggleLabelOnly,
            onCheckedChange: (val) => setToggleLabelOnly(val),
          }}
        />

        {/* Disabled */}
        <SelectorWrapper
          selectorType="toggle"
          label="Disabled toggle"
          labelBoldness="semibold"
          description="This toggle cannot be changed."
          selectorProps={{
            checked: false,
            isDisabled: true,
          }}
        />

        {/* Custom colors */}
        <SelectorWrapper
          selectorType="toggle"
          label="Custom color toggle"
          labelBoldness="semibold"
          description="Using custom on/off colors."
          selectorProps={{
            checked: toggleChecked,
            onCheckedChange: (val) => setToggleChecked(val),
            colorOn: "#10b981",
            colorOff: "#f59e0b",
          }}
        />
      </div>
    </div>
  )
}
