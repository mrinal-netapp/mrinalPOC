import type { ReactElement } from "react";

import { Chip } from "@/ui-lib/base-components/chip-list/chip-list";

interface LabelsCellProps {
  labels: readonly string[];
}

function LabelsCell({ labels }: LabelsCellProps): ReactElement {
  if (labels.length === 0) {
    return <span className="agent-list-cell-placeholder">—</span>;
  }

  return (
    <span className="labels-cell">
      {labels.map((label) => (
        <Chip key={label} label={label} isRemovable={false} />
      ))}
    </span>
  );
}

export { LabelsCell };
export type { LabelsCellProps };
