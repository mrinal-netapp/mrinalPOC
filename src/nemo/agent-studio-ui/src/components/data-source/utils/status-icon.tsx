import type { ReactElement } from "react";

import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import type { StatusVisualConfig } from "@/components/data-source/utils/data-source.utils";

function StatusIcon({ visual }: { visual: StatusVisualConfig }): ReactElement {
  if (visual.type === "spinner") {
    return <Spinner size="cell" className="ds-status-spinner" />;
  }
  const Icon = visual.Icon!;
  return <Icon size={16} style={{ color: visual.color, flexShrink: 0 }} />;
}

export { StatusIcon };
