import type { ReactElement } from "react";

import { Typography } from "@/ui-lib/base-components/typography/typography";
import type { ToolsetType } from "../toolsets-panel.types";

interface ToolsetTypeCellProps {
  type: ToolsetType;
}

function ToolsetTypeCell({ type }: ToolsetTypeCellProps): ReactElement {
  return (
    <Typography Component="span" fontSize="fs14" boldness="regular">
      {type}
    </Typography>
  );
}

export { ToolsetTypeCell };
export type { ToolsetTypeCellProps };
