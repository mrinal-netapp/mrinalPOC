import type { ReactElement } from 'react';
import { IconClock, IconFileText, IconInfoCircle } from '@tabler/icons-react';

import { Typography } from '@/ui-lib/base-components/typography/typography';
import { CardBlock, CardBlockMetric } from '@/ui-lib/base-components/card/card.block';
import { CardContentLayout } from '@/ui-lib/base-components/card/card.content-layout';

function KBEstimateSummarySection(): ReactElement {
  return (
    <section className="dset-form__section">
      <div className="dset-form__section-header">
        <Typography Component="h2" fontSize="fs14" boldness="semibold" className="dset-form__section-title">
          Estimated build summary (Placeholder missing API)
        </Typography>
      </div>

      <div className="dset-form__fields">
        <div className="dset-form__field">
          <CardContentLayout columns={2} className="kb-estimate-summary">
            <CardBlock type="metric" hasSideSeparator>
              <CardBlockMetric
                value="2.4"
                units="GB"
                subtitle="Index size"
                icon={<IconFileText />}
              />
            </CardBlock>
            <CardBlock type="metric">
              <CardBlockMetric
                value="25-35"
                units="minutes"
                subtitle="Build time"
                icon={<IconClock />}
              />
            </CardBlock>
          </CardContentLayout>
        </div>

        <div className="dset-form__field">
          <div className="dset-form__sync-notice">
            <IconInfoCircle size={20} stroke={1.5} className="kb-estimate-summary__info-icon" aria-hidden />
            <Typography Component="p" fontSize="fs14" boldness="regular">
              The build process will scan files, extract content, generate embeddings, and create the vector
              index. You can monitor progress and view logs during the build.
            </Typography>
          </div>
        </div>
      </div>
    </section>
  );
}

export { KBEstimateSummarySection };
