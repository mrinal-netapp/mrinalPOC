import { useMemo, type ReactElement } from 'react';
import { useStore } from '@tanstack/react-store';

import type { ScheduleType } from '@/api/dataset.types';
import type { AnyReactFormApi } from '@/ui-lib/base-components/form/form.types';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import { SelectorWrapper } from '@/ui-lib/base-components/selector-wrapper/selector-wrapper';
import { RadioGroup } from '@/ui-lib/base-components/radio-button/radio-button';
import { FormFieldErrorBlock } from '@/ui-lib/base-components/form';
import { InputField } from '@/ui-lib/base-components/form/form-field.input';
import { CronExpressionField } from '@/ui-lib/base-components/form/form-field.cron-expression';
import { TabGroup, TabContent } from '@/ui-lib/base-components/tab/tab-group';
import { DAY_OF_WEEK_LABELS } from '@/components/dataset/utils/dataset.utils';
import { SCHEDULE_TYPE_OPTIONS } from '@/routes/pages/data-management/dataset/create-edit/form/dataset-form.consts';
import { rangeValidator } from '@/routes/pages/data-management/dataset/create-edit/sync-settings-content.utils';

import { KB_HOURLY_MIN_MINUTES } from './kb-form.utils';

interface KBSyncScheduleContentProps {
  form: AnyReactFormApi;
}

const SYNC_TABS = [
  { id: 'builder', label: 'Use schedule builder' },
  { id: 'cron', label: 'Use cron expression' },
];

function KBSyncScheduleContent({ form }: KBSyncScheduleContentProps): ReactElement {
  const syncScheduleMode = useStore(form.store, (s) => s.values.kb_schedule.sync_schedule_mode);
  const refreshConfig = useStore(form.store, (s) => s.values.kb_schedule.refresh_config);
  const scheduleType: ScheduleType = refreshConfig.schedule_type;

  const activeScheduleTab = syncScheduleMode === 'cron' ? 'cron' : 'builder';
  const dayOfWeekError = useStore(form.store, (s) => {
    const m = s.fieldMeta['kb_schedule.refresh_config.day_of_week'];
    if (!m?.errors?.length) {
      return undefined;
    }
    return String(m.errors[0]);
  });

  const handleScheduleTypeChange = (val: string | string[]): void => {
    form.setFieldValue('kb_schedule.refresh_config.schedule_type', String(val) as ScheduleType);
  };

  const handleDayOfWeekToggle = (day: number): void => {
    /* v8 ignore start -- nullish fallback; day_of_week defaults to [] in form */
    const current = refreshConfig.day_of_week ?? [];
    /* v8 ignore stop */
    const next = current.includes(day)
      ? current.filter((d: number) => d !== day)
      : [...current, day].sort();
    form.setFieldValue('kb_schedule.refresh_config.day_of_week', next);
  };

  const intervalValidators = useMemo(
    () => rangeValidator(KB_HOURLY_MIN_MINUTES, 1440, 'Interval'),
    [],
  );
  const hourValidators = useMemo(() => rangeValidator(0, 23, 'Hour'), []);
  const minuteValidators = useMemo(() => rangeValidator(0, 59, 'Minute'), []);
  const dayOfMonthValidators = useMemo(() => rangeValidator(1, 31, 'Day of month'), []);

  return (
    <div className="dset-form__sync-content">
      <TabGroup
        tabs={SYNC_TABS}
        variant="card"
        fitting="fit-content"
        activeTabId={activeScheduleTab}
        onTabChange={(tabId) => {
          if (tabId === 'cron') {
            form.setFieldValue('kb_schedule.sync_schedule_mode', 'cron');
          } else {
            form.setFieldValue('kb_schedule.sync_schedule_mode', 'builder');
          }
        }}
      >
        <TabContent tabId="builder">
          <div className="dset-form__schedule-builder">
            <div className="dset-form__section-header">
              <Typography Component="h3" fontSize="fs14" boldness="semibold">
                Schedule frequency
              </Typography>
              <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                Select schedule frequency and configure time of the synchronization.
              </Typography>
            </div>

            <RadioGroup
              value={scheduleType}
              onValueChange={handleScheduleTypeChange}
              ariaLabel="Schedule frequency"
            >
              <div className="dset-form__schedule-radios">
                {SCHEDULE_TYPE_OPTIONS.map((opt) => (
                  <SelectorWrapper
                    key={opt.value}
                    selectorType="radioButton"
                    selectorProps={{ value: opt.value }}
                    label={opt.label}
                  />
                ))}
              </div>
            </RadioGroup>

            <Typography Component="h4" fontSize="fs14" boldness="semibold">
              {scheduleType === 'hourly' ? 'Configure interval' : 'Configure time'}
            </Typography>

            {scheduleType === 'hourly' && (
              <div className="dset-form__field">
                <InputField
                  form={form}
                  name="kb_schedule.refresh_config.interval_minutes"
                  label="Interval (minutes)"
                  type="text"
                  inputMode="numeric"
                  placeholder={String(KB_HOURLY_MIN_MINUTES)}
                  autoComplete="off"
                  validators={intervalValidators}
                />
              </div>
            )}

            {scheduleType !== 'hourly' && (
              <div className="dset-form__time-row">
                <div className="dset-form__field dset-form__field--half">
                  <InputField
                    form={form}
                    name="kb_schedule.refresh_config.time_of_day_hour"
                    label="Hour (UTC)"
                    type="text"
                    inputMode="numeric"
                    placeholder="0"
                    autoComplete="off"
                    validators={hourValidators}
                  />
                </div>
                <div className="dset-form__field dset-form__field--half">
                  <InputField
                    form={form}
                    name="kb_schedule.refresh_config.time_of_day_minute"
                    label="Minute of the hour (UTC)"
                    type="text"
                    inputMode="numeric"
                    placeholder="0"
                    autoComplete="off"
                    validators={minuteValidators}
                  />
                </div>
              </div>
            )}

            {scheduleType === 'weekly' && (
              <div className="dset-form__day-checkboxes">
                <Typography Component="label" fontSize="fs14" boldness="semibold">
                  Day of week
                </Typography>
                <div className="dset-form__day-row">
                  {DAY_OF_WEEK_LABELS.map((day) => {
                    /* v8 ignore start -- nullish fallback; day_of_week defaults to [] in form */
                    const selected = refreshConfig.day_of_week ?? [];
                    /* v8 ignore stop */
                    return (
                      <SelectorWrapper
                        key={day.value}
                        selectorType="checkbox"
                        selectorProps={{
                          checked: selected.includes(day.value),
                          onCheckedChange: () => handleDayOfWeekToggle(day.value),
                        }}
                        label={day.label}
                      />
                    );
                  })}
                </div>
                {dayOfWeekError && (
                  <FormFieldErrorBlock message={dayOfWeekError} className="dset-form__message-below" />
                )}
              </div>
            )}

            {scheduleType === 'monthly' && (
              <div className="dset-form__field">
                <InputField
                  form={form}
                  name="kb_schedule.refresh_config.day_of_month"
                  label="Day of month"
                  type="text"
                  inputMode="numeric"
                  placeholder="1"
                  autoComplete="off"
                  validators={dayOfMonthValidators}
                />
              </div>
            )}
          </div>
        </TabContent>

        <TabContent tabId="cron">
          <div className="dset-form__cron-section">
            <div className="dset-form__field">
              <CronExpressionField
                form={form}
                name="kb_schedule.refresh_config.cron_expression"
                label="Cron expression"
                placeholder="0 10 * * *"
              />
            </div>
          </div>
        </TabContent>
      </TabGroup>
    </div>
  );
}

export { KBSyncScheduleContent };
export type { KBSyncScheduleContentProps };
