import type { ReactElement } from "react";
import { IconCloudOff } from "@tabler/icons-react";

import { Typography } from "@/ui-lib/base-components/typography/typography";

import { PANEL_DEFERRED_STATE_STRINGS } from "./panel-deferred-state.consts";

interface PanelDeferredStateProps {
  /**
   * Name of the resource the panel is supposed to show — used to fill
   * the body copy (e.g. "Toolsets" → "The Toolsets endpoint is not
   * available yet…"). Caller passes a localized label.
   */
  resourceLabel: string;
}

/**
 * Banner shown by Agent details tabs whose backend endpoint isn't wired
 * yet. Replaces what would otherwise be a misleading empty table —
 * "No data" implies "the API returned zero rows", which is not the
 * case here.
 *
 * Used by `ToolsetsPanel` and `AssignedKbPanel`. Lifted into its own
 * file because two sibling panels share it; per FS-003 the shared
 * presentational helper lives next to its sibling consumers under
 * `panels/`. Pure presentational — no state, no side effects.
 */
function PanelDeferredState({ resourceLabel }: PanelDeferredStateProps): ReactElement {
  return (
    <div className="panel-deferred-state" role="status">
      <div className="panel-deferred-state__icon" aria-hidden="true">
        <IconCloudOff size={28} />
      </div>
      <Typography Component="h3" fontSize="fs16" boldness="semibold">
        {PANEL_DEFERRED_STATE_STRINGS.TITLE_PREFIX} {resourceLabel}
      </Typography>
      <Typography fontSize="fs14" color="var(--text-secondary)">
        {PANEL_DEFERRED_STATE_STRINGS.BODY}
      </Typography>
    </div>
  );
}

export { PanelDeferredState };
export type { PanelDeferredStateProps };
