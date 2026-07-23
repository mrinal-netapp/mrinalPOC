import React from "react"
import { IconPlus, IconTrash } from "@tabler/icons-react"

import { Button } from "./button"
import "./button.demo.scss"

const STATES = ["Default", "Hover / Active", "Disabled", "Loading"] as const

export default function ButtonDemo(): React.JSX.Element {
  return (
    <div className="btn-demo">
      <h2 className="btn-demo__title">Button Variants</h2>

      <div className="btn-demo__grid">
        {/* Header row */}
        <div className="btn-demo__cell btn-demo__cell--header" />
        {STATES.map((state) => (
          <div key={state} className="btn-demo__cell btn-demo__cell--header">
            {state}
          </div>
        ))}

        {/* Solid */}
        <div className="btn-demo__cell btn-demo__cell--label">Solid</div>
        <div className="btn-demo__cell">
          <Button variant="solid" size="large" icon={<IconPlus />} label="Action" />
        </div>
        <div className="btn-demo__cell btn-demo__cell--note">
          CSS :hover / :active
        </div>
        <div className="btn-demo__cell">
          <Button variant="solid" size="large" icon={<IconPlus />} label="Action" isDisabled />
        </div>
        <div className="btn-demo__cell">
          <Button variant="solid" size="large" label="Action" loading />
        </div>

        {/* Solid Destructive */}
        <div className="btn-demo__cell btn-demo__cell--label">Solid Destructive</div>
        <div className="btn-demo__cell">
          <Button variant="solid-destructive" size="large" icon={<IconTrash />} label="Delete" />
        </div>
        <div className="btn-demo__cell btn-demo__cell--note">
          CSS :hover / :active
        </div>
        <div className="btn-demo__cell">
          <Button variant="solid-destructive" size="large" icon={<IconTrash />} label="Delete" isDisabled />
        </div>
        <div className="btn-demo__cell">
          <Button variant="solid-destructive" size="large" label="Delete" loading />
        </div>

        {/* Outline */}
        <div className="btn-demo__cell btn-demo__cell--label">Outline</div>
        <div className="btn-demo__cell">
          <Button variant="outline" size="large" icon={<IconPlus />} label="Action" />
        </div>
        <div className="btn-demo__cell btn-demo__cell--note">
          CSS :hover / :active
        </div>
        <div className="btn-demo__cell">
          <Button variant="outline" size="large" icon={<IconPlus />} label="Action" isDisabled />
        </div>
        <div className="btn-demo__cell">
          <Button variant="outline" size="large" label="Action" loading />
        </div>

        {/* Flat */}
        <div className="btn-demo__cell btn-demo__cell--label">Flat</div>
        <div className="btn-demo__cell">
          <Button variant="flat" size="large" icon={<IconPlus />} label="Action" />
        </div>
        <div className="btn-demo__cell btn-demo__cell--note">
          CSS :hover / :active
        </div>
        <div className="btn-demo__cell">
          <Button variant="flat" size="large" icon={<IconPlus />} label="Action" isDisabled />
        </div>
        <div className="btn-demo__cell">
          <Button variant="flat" size="large" label="Action" loading />
        </div>

        {/* Icon */}
        <div className="btn-demo__cell btn-demo__cell--label">Icon</div>
        <div className="btn-demo__cell">
          <Button variant="icon" size="large" icon={<IconPlus />} aria-label="Add" />
          <Button variant="icon" size="medium" icon={<IconPlus />} aria-label="Add" />
          <Button variant="icon" size="small" icon={<IconPlus />} aria-label="Add" />
        </div>
        <div className="btn-demo__cell btn-demo__cell--note">
          CSS :hover / :active
        </div>
        <div className="btn-demo__cell">
          <Button variant="icon" size="large" icon={<IconPlus />} aria-label="Add" isDisabled />
        </div>
        <div className="btn-demo__cell">
          <Button variant="icon" size="large" icon={<IconPlus />} aria-label="Add" loading />
        </div>
      </div>

      {/* Size showcase */}
      <h2 className="btn-demo__title">Sizes</h2>
      <div className="btn-demo__sizes">
        <Button variant="solid" size="large" label="Large" />
        <Button variant="solid" size="medium" label="Medium" />
        <Button variant="solid" size="small" label="Small" />
        <Button variant="outline" size="large" label="Large" />
        <Button variant="outline" size="medium" label="Medium" />
        <Button variant="outline" size="small" label="Small" />
      </div>
    </div>
  )
}
