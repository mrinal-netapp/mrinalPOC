import React from "react"

import { Spinner } from "./spinner"
import "./spinner.demo.scss"

const STATES = ["Default", "Grey", "Disabled", "With Details"] as const

export default function SpinnerDemo(): React.JSX.Element {
  return (
    <div className="spinner-demo">
      <h2 className="spinner-demo__title">Spinner Variants</h2>

      <div className="spinner-demo__grid">
        {/* Header row */}
        <div className="spinner-demo__cell spinner-demo__cell--header" />
        {STATES.map((state) => (
          <div key={state} className="spinner-demo__cell spinner-demo__cell--header">
            {state}
          </div>
        ))}

        {/* Inline (32px) */}
        <div className="spinner-demo__cell spinner-demo__cell--label">Inline (32px)</div>
        <div className="spinner-demo__cell">
          <Spinner size="inline" />
        </div>
        <div className="spinner-demo__cell">
          <Spinner size="inline" isGrey />
        </div>
        <div className="spinner-demo__cell">
          <Spinner size="inline" isDisabled />
        </div>
        <div className="spinner-demo__cell">
          <Spinner size="inline" title="Loading" description="Please wait..." />
        </div>

        {/* Fit Content */}
        <div className="spinner-demo__cell spinner-demo__cell--label">Fit Content</div>
        <div className="spinner-demo__cell">
          <div style={{ width: 48, height: 48 }}>
            <Spinner size="fitContent" />
          </div>
        </div>
        <div className="spinner-demo__cell">
          <div style={{ width: 48, height: 48 }}>
            <Spinner size="fitContent" isGrey />
          </div>
        </div>
        <div className="spinner-demo__cell">
          <div style={{ width: 48, height: 48 }}>
            <Spinner size="fitContent" isDisabled />
          </div>
        </div>
        <div className="spinner-demo__cell">
          <div style={{ width: 48 }}>
            <Spinner size="fitContent" title="Syncing" description="Almost there" />
          </div>
        </div>

        {/* Full Screen */}
        <div className="spinner-demo__cell spinner-demo__cell--label">Full Screen (88px)</div>
        <div className="spinner-demo__cell spinner-demo__cell--full-screen">
          <Spinner size="fullScreen" />
        </div>
        <div className="spinner-demo__cell spinner-demo__cell--full-screen">
          <Spinner size="fullScreen" isGrey />
        </div>
        <div className="spinner-demo__cell spinner-demo__cell--full-screen">
          <Spinner size="fullScreen" isDisabled />
        </div>
        <div className="spinner-demo__cell spinner-demo__cell--full-screen">
          <Spinner size="fullScreen" title="Processing" description="This may take a moment" />
        </div>
      </div>
    </div>
  )
}
