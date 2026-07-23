import type { ReactElement } from 'react';
import { IconCircleCheck, IconCircleMinus } from '@tabler/icons-react';

import { Typography } from '@/ui-lib/base-components/typography/typography';

import './eval-property-status.scss';

const POSITIVE_STATUS_LABELS = new Set(['Healthy', 'Deployed', 'Active', 'Live', 'Enabled']);
const NEGATIVE_STATUS_LABELS = new Set(['Disabled']);

type EvalPropertyStatusProps = {
  label: string;
};

/**
 * Renders a status value with a leading glyph (success for healthy/deployed/active,
 * muted for disabled). Neutral labels (Draft, Paused, …) render plain text.
 * Mirrors the agent-details status treatment used across the evaluation flows.
 */
function EvalPropertyStatus({ label }: EvalPropertyStatusProps): ReactElement {
  const isPositive = POSITIVE_STATUS_LABELS.has(label);
  const isNegative = NEGATIVE_STATUS_LABELS.has(label);

  return (
    <span className="eval-property-status">
      {isPositive && (
        <IconCircleCheck size={16} color="var(--notification-success)" className="eval-property-status__icon" />
      )}
      {isNegative && (
        <IconCircleMinus size={16} color="var(--text-disabled)" className="eval-property-status__icon" />
      )}
      <Typography Component="span" fontSize="fs14" boldness="regular">
        {label}
      </Typography>
    </span>
  );
}

export { EvalPropertyStatus };
