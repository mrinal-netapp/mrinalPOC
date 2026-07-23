import { useMemo, type ReactElement } from 'react';
import { IconClock, IconCurrencyDollar, IconInfoCircle } from '@tabler/icons-react';

import type { EvalScoringStrategy } from '@/routes/pages/evaluations/api/eval.types';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import { Card } from '@/ui-lib/base-components/card/card';
import { CardContent } from '@/ui-lib/base-components/card/card.content';
import { CardContentLayout } from '@/ui-lib/base-components/card/card.content-layout';
import { CardBlock, CardBlockMetric } from '@/ui-lib/base-components/card/card.block';

import './eval-review-section.scss';

type ImpactEstimate = {
  durationMinutes: number;
  costUsd: number;
};

function estimateImpact(strategy: EvalScoringStrategy): ImpactEstimate {
  if (strategy === 'both' || strategy === 'llm_judge') {
    return { durationMinutes: 6.1, costUsd: 0.90 };
  }
  return { durationMinutes: 1.8, costUsd: 0.12 };
}

type EvalReviewSectionProps = {
  strategy: EvalScoringStrategy;
};

// This section is kept for future re-use (currently hidden from the Add eval form).
// It no longer reads from Redux — strategy is passed as a prop.
function EvalReviewSection({ strategy }: EvalReviewSectionProps): ReactElement {
  const impact = useMemo(() => estimateImpact(strategy), [strategy]);

  return (
    <section className="dset-form__section">
      <div className="dset-form__section-header">
        <Typography Component="h2" fontSize="fs14" boldness="semibold" className="dset-form__section-title">
          Estimated evaluation impact
        </Typography>
      </div>

      <Card className="eval-impact-card">
        <CardContent>
          <CardContentLayout columns={2} className="eval-impact-grid">
            <CardBlock type="metric" hasSideSeparator className="eval-impact-cell">
              <CardBlockMetric
                icon={<IconClock size={24} color="var(--text-button-primary)" />}
                value={impact.durationMinutes}
                units="min"
                valueSize="fs24"
                valueType="semibold"
                subtitle="Estimated duration"
              />
            </CardBlock>
            <CardBlock type="metric" className="eval-impact-cell">
              <CardBlockMetric
                icon={<IconCurrencyDollar size={24} color="var(--text-button-primary)" />}
                value={`$${impact.costUsd.toFixed(2)}`}
                valueSize="fs24"
                valueType="semibold"
                subtitle="Estimated cost"
              />
            </CardBlock>
          </CardContentLayout>
        </CardContent>
      </Card>

      <div className="eval-impact-notice">
        <IconInfoCircle size={16} color="var(--text-button-primary)" className="eval-impact-notice__icon" />
        <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
          {strategy === 'both' || strategy === 'llm_judge'
            ? 'The eval preflight will validate dataset access, run deterministic checks, and score judge dimensions where enabled. Monitor progress and drill into per-case rationales on the Evaluation runs tab.'
            : 'The eval preflight will validate dataset access and run deterministic checks only. No AI judge scoring will be performed.'}
        </Typography>
      </div>
    </section>
  );
}

export { EvalReviewSection };
