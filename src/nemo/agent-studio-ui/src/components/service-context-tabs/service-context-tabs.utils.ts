import { ROUTES } from "@/routes/routes.consts";
import { SERVICE_CONTEXT_TAB_IDS, type ServiceContextTabId } from "./service-context-tabs.consts";

function resolveActiveServiceTab(pathname: string): ServiceContextTabId {
  if (pathname.startsWith(`/${ROUTES.PROJECTS}`)) {
    return SERVICE_CONTEXT_TAB_IDS.MANAGEMENT;
  }

  return SERVICE_CONTEXT_TAB_IDS.AGENT_STUDIO;
}

export { resolveActiveServiceTab };
