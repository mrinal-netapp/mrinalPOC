import React from "react"

import { Button } from "@/ui-lib/base-components/button/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu"
import { Tooltip } from "./tooltip"
import "./tooltip.demo.scss"

export default function TooltipDemo(): React.JSX.Element {
  return (
    <div className="tooltip-demo">
      <h2 className="tooltip-demo__title">Tooltip</h2>

      {/* placement (side) with custom triggers */}
      <p className="tooltip-demo__subtitle">Placement (side)</p>
      <div className="tooltip-demo__section">
        <div className="tooltip-demo__row tooltip-demo__row--grid">
          <Tooltip content="Tooltip on top" side="top" trigger={<Button label="Top" />} />
          <Tooltip content="Tooltip on right" side="right" trigger={<Button label="Right" />} />
          <Tooltip content="Tooltip on bottom" side="bottom" trigger={<Button label="Bottom" />} />
          <Tooltip content="Tooltip on left" side="left" trigger={<Button label="Left" />} />
        </div>
      </div>

      {/* default (info icon trigger + string content) */}
      <p className="tooltip-demo__subtitle">Default (info icon + string)</p>
      <div className="tooltip-demo__section">
        <div className="tooltip-demo__row">
          <Tooltip content="Hover the info icon to see this" />
        </div>
      </div>

      {/* custom trigger (Button) */}
      <p className="tooltip-demo__subtitle">Custom trigger (Button)</p>
      <div className="tooltip-demo__section">
        <div className="tooltip-demo__row">
          <Tooltip content="Default tooltip appears on top" trigger={<Button label="Hover me" />} />
        </div>
      </div>

      {/* ReactNode content */}
      <p className="tooltip-demo__subtitle">Rich content (ReactNode)</p>
      <div className="tooltip-demo__section">
        <div className="tooltip-demo__row">
          <Tooltip
            trigger={<Button label="Details" />}
            content={
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <strong>Tooltip title</strong>
                <span>With rich content inside</span>
              </div>
            }
          />
        </div>
      </div>

      {/* tooltip inside a dropdown menu */}
      <p className="tooltip-demo__subtitle">Tooltip inside Dropdown Menu</p>
      <div className="tooltip-demo__section">
        <div className="tooltip-demo__row">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button label="Open menu" />} />
            <DropdownMenuContent>
              <DropdownMenuItem>
                Regular item
              </DropdownMenuItem>
              <DropdownMenuItem className="tooltip-demo__menu-item-with-tooltip">
                Item with info
                <Tooltip content="Extra details about this menu item" side="right" />
              </DropdownMenuItem>
              <DropdownMenuItem>
                Another item
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* long text */}
      <p className="tooltip-demo__subtitle">Long text</p>
      <div className="tooltip-demo__section">
        <div className="tooltip-demo__row">
          <Tooltip
            content="This is a longer tooltip message that wraps to multiple lines to demonstrate max-width behaviour."
            trigger={<Button label="Long" />}
          />
        </div>
      </div>
    </div>
  )
}
