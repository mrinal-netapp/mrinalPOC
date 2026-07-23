import type { ReactElement } from "react";

import { Typography } from "@/ui-lib/base-components/typography/typography";

interface AssociatedDatasetsCellProps {
  datasets: { dset_id: string; name: string }[];
  /** Full uncapped total from the backend (associated_datasets_count). Falls back to datasets.length. */
  totalCount?: number;
  deprecated: boolean;
  onNavigate?: (dsetId: string) => void;
}

function AssociatedDatasetsCell({ datasets, totalCount, deprecated, onNavigate }: AssociatedDatasetsCellProps): ReactElement {
  if (!datasets.length) return <span className="ds-cell-placeholder">—</span>;

  const first = datasets[0];
  // Use the server-supplied total so the overflow badge is correct even when
  // the backend caps the embedded array at 20. Always take at least datasets.length
  // so a zero/missing totalCount never hides the badge when the array has items.
  const overflow = Math.max(totalCount ?? 0, datasets.length) - 1;
  // to be replaced with the chip list component
  return (
    <span className="ds-datasets-cell">
      {deprecated ? (
        <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-disabled)">
          {first.name}
        </Typography>
      ) : (
        <button
          type="button"
          className="ds-name-link"
          onClick={() => onNavigate?.(first.dset_id)}
        >
          <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-button-primary)">
            {first.name}
          </Typography>
        </button>
      )}
      {overflow > 0 && (
        <Typography Component="span" fontSize="fs14" boldness="regular" color={deprecated ? "var(--text-disabled)" : "var(--text-button-primary)"}>
          +{overflow}
        </Typography>
      )}
    </span>
  );
}

export { AssociatedDatasetsCell };
export type { AssociatedDatasetsCellProps };
