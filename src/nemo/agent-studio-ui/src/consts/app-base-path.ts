import { ROUTE_PATHS } from "@/routes/routes.consts";

/** Normalized app base path without trailing slash; empty string when served at `/`. */
export function getAppBasePath(): string {
  const basePath = import.meta.env.VITE_BASE_PATH?.trim() || "/";
  if (basePath === "/") {
    return "";
  }
  return basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
}

/** React Router basename; undefined when the app is served at the host root. */
export function getRouterBasename(): string | undefined {
  const base = getAppBasePath();
  return base === "" ? undefined : base;
}

/** Full URL for the overview route (used after logout hard redirect). */
export function getOverviewUrl(): string {
  return `${window.location.origin}${getAppBasePath()}${ROUTE_PATHS.OVERVIEW}`;
}
