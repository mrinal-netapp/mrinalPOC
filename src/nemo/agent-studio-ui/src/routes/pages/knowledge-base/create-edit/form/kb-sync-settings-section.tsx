import type { ReactElement } from 'react';
import { useStore } from '@tanstack/react-store';

import type { KBSyncMode } from '@/api/kb.types';
import type { AnyReactFormApi } from '@/ui-lib/base-components/form/form.types';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import { RadioGroup } from '@/ui-lib/base-components/radio-button/radio-button';
import { SelectorWrapper } from '@/ui-lib/base-components/selector-wrapper/selector-wrapper';

import { SYNC_MODE_OPTIONS } from './kb-form.consts';
import { KBSyncScheduleContent } from './kb-sync-schedule-content';

interface KBSyncSettingsSectionProps {
  form: AnyReactFormApi;
}

function KBSyncSettingsSection({ form }: KBSyncSettingsSectionProps): ReactElement {
  const syncMode: KBSyncMode = useStore(form.store, (s) => s.values.sync_mode);

  return (
    <section className="dset-form__section">
      <div className="dset-form__section-header">
        <Typography Component="h2" fontSize="fs14" boldness="semibold" className="dset-form__section-title">
          Sync settings
        </Typography>
        <Typography Component="p" fontSize="fs14" boldness="regular" className="dset-form__section-subtitle">
          Choose how this knowledge base stays in sync with dataset changes.
        </Typography>
      </div>

      <RadioGroup
        value={syncMode}
        onValueChange={(val) => form.setFieldValue('sync_mode', String(val) as KBSyncMode)}
        ariaLabel="Knowledge base sync mode"
      >
        <div className="dset-form__input-type-radios">
          {SYNC_MODE_OPTIONS.map((opt) => (
            <SelectorWrapper
              key={opt.value}
              selectorType="radioButton"
              selectorProps={{ value: opt.value }}
              label={opt.title}
              description={opt.description}
            />
          ))}
        </div>
      </RadioGroup>

      {syncMode === 'scheduled' && <KBSyncScheduleContent form={form} />}
    </section>
  );
}

export { KBSyncSettingsSection };
export type { KBSyncSettingsSectionProps };
