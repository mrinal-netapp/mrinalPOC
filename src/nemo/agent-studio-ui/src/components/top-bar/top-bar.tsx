import type { ReactElement } from "react"
import { useNavigate } from "react-router"
import { IconMenu2 } from "@tabler/icons-react"

import { useAppDispatch } from "@/store"
import { toggleSidebar } from "@/store/slices/layout.slice"
import { ROUTES } from "@/routes/routes.consts"
import { ProjectSwitcher } from "@/components/project-switcher/project-switcher"
import { Button } from "@/ui-lib/base-components/button/button"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import netAppLogoSrc from "./netapp-logo.svg"
import { TopBarHelp } from "./help-panel"
import { TopBarNotifications } from "./notifications-panel"
import { TopBarProfileMenu } from "./top-bar-profile-menu"
import "./top-bar.scss"

function TopBar(): ReactElement {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()

  return (
    <header className="top-bar">
      <div className="top-bar__left" data-testid="top-bar-left">
        <Button
          variant="icon"
          size="large"
          icon={<IconMenu2 size={24} />}
          onClick={() => dispatch(toggleSidebar())}
          aria-label="Toggle sidebar"
        />

        <Button
          variant="flat"
          className="top-bar__logo-btn"
          icon={<img src={netAppLogoSrc} className="top-bar__logo" alt="" />}
          onClick={() => navigate(ROUTES.HOME)}
          aria-label="NetApp"
        />
      </div>

      <div className="top-bar__center" data-testid="top-bar-center">
        <Typography
          Component="h1"
          fontSize="fs16"
          boldness="semibold"
        >
          Agent Studio
        </Typography>
      </div>

      <div className="top-bar__right" data-testid="top-bar-right">
        <ProjectSwitcher />
        <TopBarNotifications />
        <TopBarHelp />
        <TopBarProfileMenu />
      </div>
    </header>
  )
}

export { TopBar }
