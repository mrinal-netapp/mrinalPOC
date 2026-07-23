import { IconCircleCheck } from "@tabler/icons-react";
import type { ReactElement } from "react";

import { Typography } from "@/ui-lib/base-components/typography/typography";

/**
 * Visual descriptor for one status value in the models domain. Mirrors the
 * `STATUS_ICON_MAP` pattern used by the data-source domain — keep the
 * lookup table at module scope in the consuming column file and pass the
 * resolved visual into this cell.
 *
 * Typed against `typeof IconCircleCheck` so the prop accepts any Tabler
 * icon (every `@tabler/icons-react` export is shaped the same way), no
 * `any` required.
 */
type ModelsStatusVisual = {
  Icon: typeof IconCircleCheck;
  color: string;
  label: string;
};

/**
 * Shared status cell for the Providers + Models tabs (and any future
 * models-domain table). Renders an icon + colored label using ui-lib
 * `Typography` so both tabs match without duplicating cell JSX.
 */
function ModelsStatusCell({ visual }: { visual: ModelsStatusVisual }): ReactElement {
  return (
    <span className="models-overview__status">
      <visual.Icon size={16} stroke={1.75} color={visual.color} aria-hidden="true" />
      <Typography Component="span" fontSize="fs14">
        {visual.label}
      </Typography>
    </span>
  );
}

export { ModelsStatusCell };
export type { ModelsStatusVisual };
