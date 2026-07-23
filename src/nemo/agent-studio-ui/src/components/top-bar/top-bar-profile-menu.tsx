import { useCallback, useState, type ReactElement } from "react"
import { IconUser } from "@tabler/icons-react"

import { isOidcAuthEnabled } from "@/contexts/auth/authConfig"
import { useAuth } from "@/contexts/auth/hooks/useAuth"
import { Button } from "@/ui-lib/base-components/button/button"
import { SidePanel } from "@/ui-lib/base-components/side-panel/side-panel"
import "./top-bar-panels.scss"

function TopBarProfileMenu(): ReactElement {
  const [open, setOpen] = useState(false)
  const oidcEnabled = isOidcAuthEnabled()
  const { isAuthenticated, user, logout } = useAuth()
  const canOpenProfile = oidcEnabled && isAuthenticated

  const handleLogout = useCallback((): void => {
    void logout()
  }, [logout])

  const profileButton = (
    <Button
      variant="icon"
      size="large"
      icon={<IconUser size={24} />}
      aria-label="User profile"
      onClick={() => {
        if (canOpenProfile) {
          setOpen(true)
        }
      }}
    />
  )

  if (!oidcEnabled || !isAuthenticated) {
    return profileButton
  }

  return (
    <>
      {profileButton}
      <SidePanel
        open={open}
        onOpenChange={setOpen}
        title={(
          <span className="top-bar-panel__title">
            <IconUser size={20} aria-hidden className="top-bar-panel__title-icon" />
            User Settings
          </span>
        )}
        headerAction={(
          <Button
            variant="solid"
            size="medium"
            label="Logout"
            onClick={handleLogout}
          />
        )}
      >
        <div className="top-bar-panel__detail-row">
          <p className="top-bar-panel__detail-label">Name</p>
          <div>
            <p className="top-bar-panel__detail-value">
              {user?.name ?? user?.email ?? "Unknown user"}
            </p>
            {user?.email !== undefined && (
              <p className="top-bar-panel__detail-meta">{user.email}</p>
            )}
          </div>
        </div>
      </SidePanel>
    </>
  )
}

export { TopBarProfileMenu }
