import { type ReactElement } from "react";
import { Navigate, useParams } from "react-router";

/**
 * Redirects legacy `/data-management/<rest>` deep links to the current top-level
 * structure (`/data-sources`, `/datasets`, …) where those pages now live. The
 * splat (`*`) carries everything after `data-management/`, so e.g.
 * `/data-management/datasets/123/edit` → `/datasets/123/edit`. Bare
 * `/data-management` is handled by the sibling index redirect.
 */
export function LegacyDataManagementRedirect(): ReactElement {
  const params = useParams();
  const rest = params["*"] ?? "";
  return <Navigate to={`/${rest}`} replace />;
}
