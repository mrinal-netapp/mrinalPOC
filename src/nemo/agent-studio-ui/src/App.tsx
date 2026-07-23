import { useEffect } from "react";
import { Outlet, useLocation } from "react-router";
import type { ReactElement } from "react";

import { useAppSelector } from "@/store";
import { layoutSelector } from "@/store/selectors/layout.selector";
import { TopBar } from "@/components/top-bar/top-bar";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { ROUTES } from "@/routes/routes.consts";
import { cn } from "@/ui-lib/lib/utils";
import "./App.scss";

// Theme applied here and mirrored onto <body> so portal-mounted elements
// (dropdowns, tooltips, etc.) also inherit the CSS custom properties.
const THEME = "light-theme" as const;

export function App(): ReactElement {
  const isSidebarOpen = useAppSelector(layoutSelector.isSidebarOpen);
  const location = useLocation();
  const isProjectsRoute = location.pathname.startsWith(`/${ROUTES.PROJECTS}`);

  useEffect(() => {
    document.body.classList.add(THEME);
    return () => document.body.classList.remove(THEME);
  }, []);

  return (
    <div className="app-shell">
      <TopBar />
      <div className="app-topbar-spacer" />

      <div className="app-body">
        {!isProjectsRoute && <AppSidebar open={isSidebarOpen} />}

        {/* data-slot="main-content" is the portal target for Dialog popups (see getContentContainer in dialog.tsx) */}
        <main
          className={cn("app-main-content", isProjectsRoute && "app-main-content--projects")}
          data-testid="app-main-content"
          data-slot="main-content"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default App;
