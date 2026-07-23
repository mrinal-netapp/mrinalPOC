import { type ReactElement } from "react"
import { useLocation, useNavigate } from "react-router"

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/ui-lib/base-components/sidebar/sidebar"
import { ServiceContextTabs } from "@/components/service-context-tabs/service-context-tabs"
import { useAuth } from "@/contexts/auth"
import { useProject } from "@/contexts/project"
import { isProjectAccessAllowed } from "@/contexts/project/model/projectAccess"
import { SIDEBAR_NAV_ITEMS, type SidebarNavItem } from "@/consts/sidebar-nav.consts"
import "./app-sidebar.scss"

interface AppSidebarProps {
  open: boolean
}

function defaultNavActive(path: string, pathname: string): boolean {
  // all SIDEBAR_NAV_ITEMS paths start with "/"; the ternary fallback is a defensive guard
  /* v8 ignore start */
  const to = path.startsWith("/") ? path : `/${path}`
  /* v8 ignore stop */
  return pathname === to || pathname.startsWith(`${to}/`)
}

// place holder for NavLink when SidebarMenuButton supports link elements
function NavItem({ path, label, icon }: SidebarNavItem): ReactElement {
  const navigate = useNavigate()
  const location = useLocation()
  // all SIDEBAR_NAV_ITEMS paths start with "/"; the ternary fallback is a defensive guard
  /* v8 ignore start */
  const to = path.startsWith("/") ? path : `/${path}`
  /* v8 ignore stop */
  const isActive = defaultNavActive(path, location.pathname)

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        icon={icon}
        label={label}
        isActive={isActive}
        onButtonClick={() => navigate(to)}
      />
    </SidebarMenuItem>
  )
}

function AppSidebar({ open }: AppSidebarProps): ReactElement {
  const { activeProject, hasActiveProject } = useProject()
  const { roles: authRoles } = useAuth()

  // Gate each item on BOTH project presence (`requireProject`, defaults
  // true) and the role allow-list — the same `isProjectAccessAllowed`
  // contract `ProjectGuard` uses for route-level guarding.
  //
  // Role sources are deliberately unioned:
  //   - active project membership role → unlocks per-project items
  //     (Credentials/Observability/Administration with role "admin"/"member"/…)
  //   - auth realm roles → unlocks platform-level items
  //     (Jobs/Configurations/Chatbot with "super-admin", etc.) even
  //     when no active project is selected.
  const userRoles = [activeProject?.role, ...authRoles]
  const visibleItems = SIDEBAR_NAV_ITEMS.filter((item) =>
    isProjectAccessAllowed({
      requireProject: item.requireProject ?? true,
      hasActiveProject,
      requiredRoles: item.requiredRoles,
      userRoles,
    }),
  )

  return (
    <Sidebar open={open}>
      <ServiceContextTabs />

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {visibleItems.map((item) => (
              <NavItem key={item.path} {...item} />
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}

export { AppSidebar }
