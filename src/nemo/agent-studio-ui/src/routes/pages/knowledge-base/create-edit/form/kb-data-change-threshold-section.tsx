import type { ReactElement } from 'react';
import { useMemo } from 'react';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useStore } from '@tanstack/react-store';

import type { AnyReactFormApi } from '@/ui-lib/base-components/form/form.types';
import { ToggleField } from '@/ui-lib/base-components/form';
import { InputField } from '@/ui-lib/base-components/form/form-field.input';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import { rangeValidator } from '@/routes/pages/data-management/dataset/create-edit/sync-settings-content.utils';

interface KBDataChangeThresholdSectionProps {
  form: AnyReactFormApi;
}

function KBDataChangeThresholdSection({ form }: KBDataChangeThresholdSectionProps): ReactElement {
  const enabled = useStore(form.store, (s) => s.values.data_change_threshold_enabled);
  const thresholdValidators = useMemo(() => rangeValidator(1, 5000, 'Minimum file changes'), []);

  return (
    <section className="dset-form__section">
      <div className="dset-form__section-header">
        <Typography Component="h2" fontSize="fs14" boldness="semibold" className="dset-form__section-title">
          Data change threshold
        </Typography>
        <Typography Component="p" fontSize="fs14" boldness="regular" className="dset-form__section-subtitle">
          Select to synchronize based on a specified minimum file change threshold.
        </Typography>
      </div>

      <div className="dset-form__fields">
        <div className="dset-form__field">
          <ToggleField form={form} name="data_change_threshold_enabled" label="Enable data change threshold" />
        </div>

        {!enabled && (
          <div className="dset-form__sync-notice">
            <IconAlertTriangle
              size={20}
              stroke={1.5}
              className="kb-data-change-threshold__warning-icon"
              aria-hidden
            />
            <Typography Component="p" fontSize="fs14" boldness="regular">
              If disabled, a new version is created for each file change.
            </Typography>
          </div>
        )}

        {enabled && (
          <div className="dset-form__field">
            <InputField
              form={form}
              name="data_change_threshold_value"
              label="Minimum file changes before new version"
              type="text"
              inputMode="numeric"
              placeholder="1"
              autoComplete="off"
              validators={thresholdValidators}
            />
          </div>
        )}
      </div>
    </section>
  );
}

export { KBDataChangeThresholdSection };
export type { KBDataChangeThresholdSectionProps };
