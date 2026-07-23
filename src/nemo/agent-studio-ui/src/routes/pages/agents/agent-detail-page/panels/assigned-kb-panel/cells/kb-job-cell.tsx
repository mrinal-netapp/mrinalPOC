import type { ReactElement } from "react";

import { Typography } from "@/ui-lib/base-components/typography/typography";

import type { KnowledgeBaseJobDetails } from "../assigned-kb-panel.types";
import {
  ASSIGNED_KB_PANEL_STRINGS,
  KB_JOB_SEGMENT_COUNT,
} from "../assigned-kb-panel.consts";

interface KbJobCellProps {
  job: KnowledgeBaseJobDetails;
}

const JOB_STATE_LABEL: Record<KnowledgeBaseJobDetails["state"], string> = {
  Ready: ASSIGNED_KB_PANEL_STRINGS.JOB_READY,
  Processing: ASSIGNED_KB_PANEL_STRINGS.JOB_PROCESSING,
};

function KbJobCell({ job }: KbJobCellProps): ReactElement {
  const clamped = Math.min(1, Math.max(0, job.progress));
  const filledCount = Math.ceil(clamped * KB_JOB_SEGMENT_COUNT);

  const stateModifier =
    job.state === "Ready"
      ? "kb-job-cell__segment--ready"
      : "kb-job-cell__segment--processing";

  return (
    <span className="kb-job-cell">
      <span
        className="kb-job-cell__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={clamped}
        aria-label={JOB_STATE_LABEL[job.state]}
      >
        {Array.from({ length: KB_JOB_SEGMENT_COUNT }).map((_, idx) => {
          const isFilled = idx < filledCount;
          return (
            <span
              key={idx}
              className={`kb-job-cell__segment ${isFilled ? stateModifier : ""}`}
            />
          );
        })}
      </span>
      <Typography Component="span" fontSize="fs14" boldness="regular">
        {JOB_STATE_LABEL[job.state]}
      </Typography>
    </span>
  );
}

export { KbJobCell };
export type { KbJobCellProps };
