import type { ReactElement } from "react";

import type { KBStatus } from "@/api/kb.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { StatusIcon } from "@/components/data-source/utils/status-icon";
import { DEPRECATED_VISUAL } from "@/components/data-source/utils/data-source.utils";
import { getKBStatusLabel, getKBStatusVisual } from "@/components/knowledge-base/utils/kb.utils";

function KBStatusCell({ status, deprecated }: { status: KBStatus; deprecated: boolean }): ReactElement {
  const visual = deprecated ? DEPRECATED_VISUAL : getKBStatusVisual(status);
  const label = getKBStatusLabel(status, deprecated);

  return (
    <span className="kb-list-status-cell">
      <StatusIcon visual={visual} />
      <Typography Component="span" fontSize="fs14" boldness="regular">
        {label}
      </Typography>
    </span>
  );
}

export { KBStatusCell };
