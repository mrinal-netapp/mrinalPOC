import React, { useState } from "react"

import { Typography } from "@/ui-lib/base-components/typography/typography"
import { Input } from "./input"
import "./input.demo.scss"

export default function InputDemo(): React.JSX.Element {
  const [controlledValue, setControlledValue] = useState("Hello world")

  return (
    <div className="input-demo">
      {/* ===== All States ===== */}
      <h2 className="input-demo__title">Input — States</h2>

      <div className="input-demo__grid">
        <div className="input-demo__cell input-demo__cell--header">State</div>
        <div className="input-demo__cell input-demo__cell--header">Component</div>

        {/* Default Empty */}
        <div className="input-demo__cell input-demo__cell--label">Default Empty</div>
        <div className="input-demo__cell">
          <div className="input-demo__field">
            <Input label="Label" />
          </div>
        </div>

        {/* Default PH */}
        <div className="input-demo__cell input-demo__cell--label">Default PH</div>
        <div className="input-demo__cell">
          <div className="input-demo__field">
            <Input label="Label" placeholder="Placeholder text" />
          </div>
        </div>

        {/* Hover */}
        <div className="input-demo__cell input-demo__cell--label">Hover</div>
        <div className="input-demo__cell">
          <div className="input-demo__field">
            <Input label="Label" placeholder="Placeholder text" className="demo--hover" />
          </div>
        </div>

        {/* Focus */}
        <div className="input-demo__cell input-demo__cell--label">Focus</div>
        <div className="input-demo__cell">
          <div className="input-demo__field">
            <Input label="Label" placeholder="Placeholder text" className="demo--focus" />
          </div>
        </div>

        {/* Active */}
        <div className="input-demo__cell input-demo__cell--label">Active</div>
        <div className="input-demo__cell">
          <div className="input-demo__field">
            <Input label="Label" defaultValue="Input text" />
          </div>
        </div>

        {/* Filled */}
        <div className="input-demo__cell input-demo__cell--label">Filled</div>
        <div className="input-demo__cell">
          <div className="input-demo__field">
            <Input label="Label" defaultValue="Input text" />
          </div>
        </div>

        {/* Error */}
        <div className="input-demo__cell input-demo__cell--label">Error</div>
        <div className="input-demo__cell">
          <div className="input-demo__field">
            <Input label="Label" defaultValue="Input text" isError />
          </div>
        </div>

        {/* Warning */}
        <div className="input-demo__cell input-demo__cell--label">Warning</div>
        <div className="input-demo__cell">
          <div className="input-demo__field">
            <Input label="Label" defaultValue="Input text" isWarning />
          </div>
        </div>

        {/* Disabled */}
        <div className="input-demo__cell input-demo__cell--label">Disabled</div>
        <div className="input-demo__cell">
          <div className="input-demo__field">
            <Input label="Label" defaultValue="Input text" isDisabled />
          </div>
        </div>

        {/* Read-only */}
        <div className="input-demo__cell input-demo__cell--label">Read-only</div>
        <div className="input-demo__cell">
          <div className="input-demo__field">
            <Input label="Label" defaultValue="Input text" readOnly />
          </div>
        </div>

        {/* Character counter */}
        <div className="input-demo__cell input-demo__cell--label">Character counter</div>
        <div className="input-demo__cell">
          <div className="input-demo__field">
            <Input label="Label" isShowCount max={500} />
          </div>
        </div>
      </div>

      {/* ===== Label / Optional / Tooltip Combos ===== */}
      <h2 className="input-demo__title">Input — Label, Optional & Tooltip Combos</h2>
      <div className="input-demo__section">
        <div className="input-demo__row">
          <div className="input-demo__field">
            <Input label="Label only" />
          </div>
          <div className="input-demo__field">
            <Input isOptional />
          </div>
          <div className="input-demo__field">
            <Input tooltip="Standalone tooltip, no label" />
          </div>
        </div>
        <div className="input-demo__row">
          <div className="input-demo__field">
            <Input label="Label" isOptional />
          </div>
          <div className="input-demo__field">
            <Input label="Label" tooltip="Helpful info" />
          </div>
          <div className="input-demo__field">
            <Input isOptional tooltip="Optional with tooltip, no label" />
          </div>
        </div>
        <div className="input-demo__row">
          <div className="input-demo__field">
            <Input label="Label" isOptional tooltip="All three together" />
          </div>
          <div className="input-demo__field">
            <Input placeholder="No label, no optional, no tooltip" />
          </div>
        </div>
      </div>

      {/* ===== Input Types ===== */}
      <h2 className="input-demo__title">Input — Types</h2>
      <div className="input-demo__section">
        <div className="input-demo__row">
          <div className="input-demo__field">
            <Input label="Text" type="text" placeholder="Text input" />
          </div>
          <div className="input-demo__field">
            <Input label="Email" type="email" placeholder="user@example.com" />
          </div>
        </div>
        <div className="input-demo__row">
          <div className="input-demo__field">
            <Input label="Password" type="password" placeholder="Enter password" />
          </div>
          <div className="input-demo__field">
            <Input label="Number" type="number" placeholder="0" />
          </div>
        </div>
        <div className="input-demo__row">
          <div className="input-demo__field">
            <Input label="URL" type="url" placeholder="https://example.com" />
          </div>
          <div className="input-demo__field">
            <Input label="Tel" type="tel" placeholder="+1 (555) 000-0000" />
          </div>
        </div>
        <div className="input-demo__row">
          <div className="input-demo__field">
            <Input label="Search" type="search" placeholder="Search..." />
          </div>
          <div className="input-demo__field">
            <Input label="File" type="file" />
          </div>
        </div>
      </div>

      {/* ===== Controlled vs Uncontrolled ===== */}
      <h2 className="input-demo__title">Input — Controlled vs Uncontrolled</h2>
      <div className="input-demo__section">
        <div className="input-demo__row">

          {/* Controlled: React owns the value via state */}
          <div className="input-demo__field">
            <Input
              label="Controlled"
              value={controlledValue}
              onChange={(e) => setControlledValue(e.target.value)}
              isShowCount
              max={100}
            />
          </div>

          {/* Uncontrolled: DOM owns the value, counter still tracks via handleChange */}
          <div className="input-demo__field">
            <Input
              label="Uncontrolled"
              isShowCount
              max={100}
            />
          </div>

        </div>

        {/* Only controlled exposes value to React state */}
        <div className="input-demo__output">
          <Typography Component="span" fontSize="fs14" boldness="semibold">
            Controlled value:
          </Typography>
          <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
            {controlledValue || "(empty)"}
          </Typography>
        </div>
      </div>
    </div>
  )
}
