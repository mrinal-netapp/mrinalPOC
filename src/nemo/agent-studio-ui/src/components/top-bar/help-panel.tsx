import { useState, type ReactElement } from "react"
import { IconHelpCircle } from "@tabler/icons-react"

import { SidePanel } from "@/ui-lib/base-components/side-panel/side-panel"
import { Button } from "@/ui-lib/base-components/button/button"
import { HELP_PANEL_LINKS } from "./top-bar-panels.consts"
import "./top-bar-panels.scss"

function TopBarHelp(): ReactElement {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button
        variant="icon"
        size="large"
        icon={<IconHelpCircle size={24} />}
        aria-label="Help"
        onClick={() => setOpen(true)}
      />

      <SidePanel
        open={open}
        onOpenChange={setOpen}
        title={(
          <span className="top-bar-panel__title">
            <IconHelpCircle size={20} aria-hidden className="top-bar-panel__title-icon" />
            Help
          </span>
        )}
      >
        {HELP_PANEL_LINKS.map((link) => (
          <button key={link.label} type="button" className="top-bar-panel__row-link" disabled>
            {link.label}
          </button>
        ))}
      </SidePanel>
    </>
  )
}

export { TopBarHelp }
