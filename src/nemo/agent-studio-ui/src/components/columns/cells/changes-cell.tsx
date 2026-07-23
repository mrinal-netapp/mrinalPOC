import type { ReactElement } from "react";

import { Typography } from "@/ui-lib/base-components/typography/typography";

interface ChangesCellProps {
  added?: number | null;
  removed?: number | null;
}

function ChangesCell({ added, removed }: ChangesCellProps): ReactElement {
  if (added == null && removed == null) {
    return (
      <Typography Component="span" fontSize="fs14" boldness="regular">
        n/a
      </Typography>
    );
  }

  // the API always provides both added and removed together; the ?? 0 fallback is a defensive guard against partial data
  /* v8 ignore start */
  if ((added ?? 0) === 0 && (removed ?? 0) === 0) {
  /* v8 ignore stop */
    return (
      <Typography Component="span" fontSize="fs14" boldness="regular">
        No changes
      </Typography>
    );
  }

  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {added != null && added > 0 && (
        <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--notification-success)">
          +{added}
        </Typography>
      )}
      {removed != null && removed > 0 && (
        <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--notification-error)">
          -{removed}
        </Typography>
      )}
    </span>
  );
}

export { ChangesCell };
export type { ChangesCellProps };
