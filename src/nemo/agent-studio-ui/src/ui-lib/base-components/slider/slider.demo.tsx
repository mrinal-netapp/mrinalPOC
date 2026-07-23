import React, { useState } from "react"

import { Button } from "@/ui-lib/base-components/button/button"
import { Slider } from "./slider"
import "./slider.demo.scss"

export default function SliderDemo(): React.JSX.Element {
  const [controlled, setControlled] = useState(40)
  const [committed, setCommitted] = useState<number | readonly number[]>(50)

  return (
    <div className="slider-demo">
      <h2 className="slider-demo__title">Slider</h2>

      {/* horizontal (default) */}
      <p className="slider-demo__subtitle">Horizontal (default)</p>
      <div className="slider-demo__section">
        <div className="slider-demo__row">
          <Slider defaultValue={50} label="Brightness" />
        </div>
      </div>

      {/* no label */}
      <p className="slider-demo__subtitle">No label</p>
      <div className="slider-demo__section">
        <div className="slider-demo__row">
          <Slider defaultValue={50} />
        </div>
      </div>

      {/* small size */}
      <p className="slider-demo__subtitle">Small size</p>
      <div className="slider-demo__section">
        <div className="slider-demo__row">
          <Slider defaultValue={30} size="small" label="Opacity" />
        </div>
      </div>

      {/* custom min / max / step */}
      <p className="slider-demo__subtitle">Custom min / max / step (0–10, step 2)</p>
      <div className="slider-demo__section">
        <div className="slider-demo__row">
          <Slider defaultValue={4} min={0} max={10} step={2} label="Rating" />
        </div>
      </div>

      {/* disabled */}
      <p className="slider-demo__subtitle">Disabled</p>
      <div className="slider-demo__section">
        <div className="slider-demo__row">
          <Slider defaultValue={60} isDisabled label="Locked" />
        </div>
      </div>

      {/* range (two thumbs) */}
      <p className="slider-demo__subtitle">Range (two thumbs)</p>
      <div className="slider-demo__section">
        <div className="slider-demo__row">
          <Slider defaultValue={[25, 75]} label="Price range" />
        </div>
      </div>

      {/* vertical */}
      <p className="slider-demo__subtitle">Vertical</p>
      <div className="slider-demo__section">
        <div className="slider-demo__row slider-demo__row--tall">
          <Slider defaultValue={50} orientation="vertical" label="Volume" />
        </div>
      </div>

      {/* vertical small */}
      <p className="slider-demo__subtitle">Vertical + small</p>
      <div className="slider-demo__section">
        <div className="slider-demo__row slider-demo__row--tall">
          <Slider defaultValue={70} orientation="vertical" size="small" label="Gain" />
        </div>
      </div>

      {/* controlled with buttons */}
      <p className="slider-demo__subtitle">Controlled (value: {controlled})</p>
      <div className="slider-demo__section">
        <div className="slider-demo__row">
          <div className="slider-demo__controlled">
            <div className="slider-demo__buttons">
              <Button
                label="-10"
                variant="outline"
                onClick={() => setControlled((v) => Math.max(0, v - 10))}
              />
              <Button
                label="+10"
                variant="outline"
                onClick={() => setControlled((v) => Math.min(100, v + 10))}
              />
            </div>
            <Slider
              value={controlled}
              onValueChange={(v) => setControlled(v as number)}
              label="Controlled"
            />
          </div>
        </div>
      </div>

      {/* onValueCommitted */}
      <p className="slider-demo__subtitle">
        onValueCommitted (committed: {String(committed)})
      </p>
      <div className="slider-demo__section">
        <div className="slider-demo__row">
          <Slider
            defaultValue={50}
            onValueCommitted={(v) => setCommitted(v)}
            label="Release to commit"
          />
        </div>
      </div>

      {/* show limits */}
      <p className="slider-demo__subtitle">Show limits (isShowLimits)</p>
      <div className="slider-demo__section">
        <div className="slider-demo__row">
          <Slider defaultValue={850} min={100} max={2000} isShowLimits label="Capacity" />
        </div>
      </div>

      {/* show current value */}
      <p className="slider-demo__subtitle">Show current value (isShowCurrent)</p>
      <div className="slider-demo__section">
        <div className="slider-demo__row">
          <Slider defaultValue={50} isShowCurrent label="Volume" />
        </div>
      </div>

      {/* show limits + current value */}
      <p className="slider-demo__subtitle">Limits + current value</p>
      <div className="slider-demo__section">
        <div className="slider-demo__row">
          <Slider defaultValue={850} min={100} max={2000} isShowLimits isShowCurrent label="Storage" />
        </div>
      </div>

      {/* editable input */}
      <p className="slider-demo__subtitle">Editable input (isEditInput)</p>
      <div className="slider-demo__section">
        <div className="slider-demo__row">
          <Slider
            defaultValue={850}
            min={100}
            max={2000}
            isShowLimits
            isShowCurrent
            isEditInput
            label="Throughput"
          />
        </div>
      </div>

      {/* editable input controlled */}
      <p className="slider-demo__subtitle">
        Editable input controlled (value: {controlled})
      </p>
      <div className="slider-demo__section">
        <div className="slider-demo__row">
          <Slider
            value={controlled}
            onValueChange={(v) => setControlled(v as number)}
            min={0}
            max={100}
            isShowLimits
            isShowCurrent
            isEditInput
            label="Controlled editable"
          />
        </div>
      </div>

      {/* custom className */}
      <p className="slider-demo__subtitle">Custom className</p>
      <div className="slider-demo__section">
        <div className="slider-demo__row">
          <Slider defaultValue={50} className="slider-demo__custom" label="Styled" />
        </div>
      </div>
    </div>
  )
}
