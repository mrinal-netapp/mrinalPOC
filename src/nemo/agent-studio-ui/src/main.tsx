import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { RouterProvider } from "react-router";
import { store } from "@/store/store";
import { router } from "@/routes/router";
import { AuthProvider } from "@/contexts/auth";
import { ApiAuthBridge } from "@/contexts/auth/components/ApiAuthBridge";
import { ProjectProvider } from "@/contexts/project";
import { TooltipProvider } from "@/ui-lib/base-components/tooltip/tooltip";
import { Toaster } from "@/ui-lib/base-components/toast/toast.toaster";
import "./index.scss";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Provider store={store}>
      <AuthProvider>
        <ApiAuthBridge>
          <ProjectProvider>
            <TooltipProvider>
              <RouterProvider router={router} />
              <Toaster position="bottom-center" />
            </TooltipProvider>
          </ProjectProvider>
        </ApiAuthBridge>
      </AuthProvider>
    </Provider>
  </StrictMode>,
);
