import { useState, type ReactElement } from "react"
import {
  IconBell,
  IconBellOff,
  IconChevronDown,
} from "@tabler/icons-react"

import { SidePanel } from "@/ui-lib/base-components/side-panel/side-panel"
import { Button } from "@/ui-lib/base-components/button/button"
import "./top-bar-panels.scss"

function TopBarNotifications(): ReactElement {
  const [open, setOpen] = useState(false)

  return (
    <>
      <span className="top-bar-panel-trigger">
        <Button
          variant="icon"
          size="large"
          icon={<IconBell size={24} />}
          aria-label="Notifications"
          onClick={() => setOpen(true)}
        />
      </span>

      <SidePanel
        open={open}
        onOpenChange={setOpen}
        title={(
          <span className="top-bar-panel__title">
            <IconBell size={20} aria-hidden className="top-bar-panel__title-icon" />
            Notifications
          </span>
        )}
        headerAction={(
          <button type="button" className="top-bar-panel__link-button" disabled>
            Go To Settings
          </button>
        )}
        width={480}
      >
        <div className="top-bar-panel__filters">
          <button type="button" className="top-bar-panel__filter" disabled>
            (Filter Services All)
            <IconChevronDown size={14} aria-hidden />
          </button>
          <button type="button" className="top-bar-panel__filter" disabled>
            (Filter Type All)
            <IconChevronDown size={14} aria-hidden />
          </button>
        </div>

        <div className="top-bar-panel__empty">
          <IconBellOff size={32} aria-hidden className="top-bar-panel__empty-icon" />
          <p className="top-bar-panel__empty-title">No notifications</p>
          <p className="top-bar-panel__empty-description">You're all caught up.</p>
        </div>
      </SidePanel>
    </>
  )
}

export { TopBarNotifications }
