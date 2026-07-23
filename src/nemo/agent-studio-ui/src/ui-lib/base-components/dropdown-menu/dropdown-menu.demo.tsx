import React, { useState } from "react"

import { Button } from "@/ui-lib/base-components/button/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuGroup,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./dropdown-menu"
import "./dropdown-menu.demo.scss"

export default function DropdownMenuDemo(): React.JSX.Element {
  const [showStatus, setShowStatus] = useState(true)
  const [showActivity, setShowActivity] = useState(false)
  const [fontSize, setFontSize] = useState("medium")
  const [log, setLog] = useState<string[]>([])

  const pushLog = (message: string) =>
    setLog((prev) => [...prev.slice(-9), message])

  return (
    <div className="dropdown-menu-demo">
      <h2 className="dropdown-menu-demo__title">Dropdown Menu</h2>

      {/* basic action menu */}
      <p className="dropdown-menu-demo__subtitle">Basic action menu</p>
      <div className="dropdown-menu-demo__section">
        <div className="dropdown-menu-demo__row">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button label="Actions" />} />
            <DropdownMenuContent>
              <DropdownMenuItem>New file</DropdownMenuItem>
              <DropdownMenuItem>New folder</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* with label + separator */}
      <p className="dropdown-menu-demo__subtitle">With label and separator</p>
      <div className="dropdown-menu-demo__section">
        <div className="dropdown-menu-demo__row">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button label="Account" />} />
            <DropdownMenuContent>
              <DropdownMenuGroup>
                <DropdownMenuLabel>My Account</DropdownMenuLabel>
                <DropdownMenuItem>Profile</DropdownMenuItem>
                <DropdownMenuItem>Settings</DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem>Log out</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* checkbox items */}
      <p className="dropdown-menu-demo__subtitle">Checkbox items</p>
      <div className="dropdown-menu-demo__section">
        <div className="dropdown-menu-demo__row">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button label="View" />} />
            <DropdownMenuContent>
              <DropdownMenuCheckboxItem
                checked={showStatus}
                onCheckedChange={setShowStatus}
              >
                Show status bar
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={showActivity}
                onCheckedChange={setShowActivity}
              >
                Show activity panel
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* radio items */}
      <p className="dropdown-menu-demo__subtitle">Radio items</p>
      <div className="dropdown-menu-demo__section">
        <div className="dropdown-menu-demo__row">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button label="Font size" />} />
            <DropdownMenuContent>
              <DropdownMenuRadioGroup value={fontSize} onValueChange={setFontSize}>
                <DropdownMenuRadioItem value="small">Small</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="medium">Medium</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="large">Large</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* submenu */}
      <p className="dropdown-menu-demo__subtitle">With submenu</p>
      <div className="dropdown-menu-demo__section">
        <div className="dropdown-menu-demo__row">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button label="More" />} />
            <DropdownMenuContent>
              <DropdownMenuItem>Cut</DropdownMenuItem>
              <DropdownMenuItem>Copy</DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Share</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem>Email</DropdownMenuItem>
                  <DropdownMenuItem>Slack</DropdownMenuItem>
                  <DropdownMenuItem>Teams</DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled>Paste (disabled)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* onClick callbacks */}
      <p className="dropdown-menu-demo__subtitle">onClick callbacks (see log below)</p>
      <div className="dropdown-menu-demo__section">
        <div className="dropdown-menu-demo__row">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button label="Interactive" />} />
            <DropdownMenuContent>
              <DropdownMenuGroup>
                <DropdownMenuLabel>Actions</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => pushLog("Clicked: New file")}>
                  New file
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => pushLog("Clicked: Rename")}>
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => pushLog("Clicked: Delete")}
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuGroup>

              <DropdownMenuSeparator />

              <DropdownMenuCheckboxItem
                checked={showStatus}
                onCheckedChange={(checked) => {
                  setShowStatus(checked)
                  pushLog(`Checkbox: Status bar → ${checked}`)
                }}
              >
                Status bar
              </DropdownMenuCheckboxItem>

              <DropdownMenuSeparator />

              <DropdownMenuRadioGroup
                value={fontSize}
                onValueChange={(value) => {
                  setFontSize(value)
                  pushLog(`Radio: Font size → ${value}`)
                }}
              >
                <DropdownMenuRadioItem value="small">Small</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="medium">Medium</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="large">Large</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>

              <DropdownMenuSeparator />

              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Share via…</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem onClick={() => pushLog("Clicked: Share → Email")}>
                    Email
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => pushLog("Clicked: Share → Slack")}>
                    Slack
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>

              <DropdownMenuSeparator />

              <DropdownMenuItem disabled onClick={() => pushLog("Should not fire")}>
                Disabled item
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="dropdown-menu-demo__log">
          <p className="dropdown-menu-demo__log-title">Event log</p>
          {log.length === 0 ? (
            <p className="dropdown-menu-demo__log-empty">Click a menu item…</p>
          ) : (
            log.map((entry, i) => (
              <p key={i} className="dropdown-menu-demo__log-entry">{entry}</p>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
