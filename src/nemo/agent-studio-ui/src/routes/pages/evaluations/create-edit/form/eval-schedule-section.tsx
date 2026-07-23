import type { ReactElement } from 'react';

import { Typography } from '@/ui-lib/base-components/typography/typography';
import { Input } from '@/ui-lib/base-components/input/input';
import { TabGroup, TabContent } from '@/ui-lib/base-components/tab/tab-group';
import { RadioGroup } from '@/ui-lib/base-components/radio-button/radio-button';
import { SelectorWrapper } from '@/ui-lib/base-components/selector-wrapper/selector-wrapper';
import { Tooltip } from '@/ui-lib/base-components/tooltip/tooltip';

import './eval-schedule-section.scss';

type ScheduleMode = 'builder' | 'cron';
type ScheduleCadence = 'hourly' | 'daily' | 'weekly' | 'monthly';

const SCHEDULE_TABS = [
  { id: 'builder', label: 'Use schedule builder' },
  { id: 'cron', label: 'Use cron expression' },
];

const CADENCE_OPTIONS: Array<{ value: ScheduleCadence; title: string }> = [
  { value: 'hourly', title: 'Hourly' },
  { value: 'daily', title: 'Daily' },
  { value: 'weekly', title: 'Weekly' },
  { value: 'monthly', title: 'Monthly' },
];

type EvalScheduleSectionProps = {
  scheduleEnabled: boolean;
  scheduleMode: ScheduleMode;
  scheduleCadence: ScheduleCadence;
  scheduleHourUtc: number;
  scheduleMinuteUtc: number;
  scheduleCron: string;
  onScheduleEnabledChange: (enabled: boolean) => void;
  onScheduleModeChange: (mode: ScheduleMode) => void;
  onScheduleCadenceChange: (cadence: ScheduleCadence) => void;
  onScheduleHourUtcChange: (hour: number) => void;
  onScheduleMinuteUtcChange: (minute: number) => void;
  onScheduleCronChange: (cron: string) => void;
};

function EvalScheduleSection({
  scheduleEnabled,
  scheduleMode,
  scheduleCadence,
  scheduleHourUtc,
  scheduleMinuteUtc,
  scheduleCron,
  onScheduleEnabledChange,
  onScheduleModeChange,
  onScheduleCadenceChange,
  onScheduleHourUtcChange,
  onScheduleMinuteUtcChange,
  onScheduleCronChange,
}: EvalScheduleSectionProps): ReactElement {
  return (
    <section className="dset-form__section">
      <div className="dset-form__section-header">
        <Typography Component="h2" fontSize="fs14" boldness="semibold" className="dset-form__section-title">
          Automatic scheduled runs
        </Typography>
        <Typography Component="p" fontSize="fs14" boldness="regular" className="dset-form__section-subtitle">
          Schedule recurring evaluations for this agent version. You can still run manually at any time.
        </Typography>
      </div>
      <div className="dset-form__fields">
        {/* Master toggle */}
        <div className="dset-form__field">
          <label className="dset-form__checkbox-label">
            <input
              type="checkbox"
              checked={scheduleEnabled}
              onChange={() => onScheduleEnabledChange(!scheduleEnabled)}
            />
            <Typography Component="span" fontSize="fs14" boldness="regular">
              Enable automatic scheduled runs
            </Typography>
          </label>
        </div>

        {/* Scheduler — only visible when enabled */}
        {scheduleEnabled && (
          <div className="eval-schedule__builder">
            <TabGroup
              tabs={SCHEDULE_TABS}
              activeTabId={scheduleMode}
              onTabChange={(id) => onScheduleModeChange(id as ScheduleMode)}
              ariaLabel="Schedule type"
              className="eval-schedule__tabs"
            >
              {/* ── Builder tab ── */}
              <TabContent tabId="builder">
                <div className="eval-schedule__builder-body">
                  <RadioGroup
                    ariaLabel="Cadence"
                    value={scheduleCadence}
                    onValueChange={(val) => onScheduleCadenceChange(val as ScheduleCadence)}
                    className="eval-schedule__cadence-group"
                  >
                    {CADENCE_OPTIONS.map((opt) => (
                      <SelectorWrapper
                        key={opt.value}
                        selectorType="radioButton"
                        selectorProps={{ value: opt.value }}
                        label={opt.title}
                      />
                    ))}
                  </RadioGroup>

                  {scheduleCadence !== 'hourly' && (
                    <div className="eval-schedule__time-inputs">
                      <div className="eval-schedule__time-field">
                        <Input
                          label="Hour (UTC)"
                          type="number"
                          value={String(scheduleHourUtc)}
                          onChange={(e) => {
                            const v = Math.max(0, Math.min(23, Number(e.target.value)));
                            onScheduleHourUtcChange(v);
                          }}
                        />
                      </div>
                      <div className="eval-schedule__time-field">
                        <Input
                          label="Minute"
                          type="number"
                          value={String(scheduleMinuteUtc)}
                          onChange={(e) => {
                            const v = Math.max(0, Math.min(59, Number(e.target.value)));
                            onScheduleMinuteUtcChange(v);
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </TabContent>

              {/* ── Cron tab ── */}
              <TabContent tabId="cron">
                <div className="eval-schedule__cron-body">
                  <div className="eval-schedule__cron-field">
                    <span className="eval-schedule__cron-label">
                      <Typography Component="label" fontSize="fs14" boldness="regular">
                        Cron expression
                      </Typography>
                      <Tooltip
                        content={
                          <span>
                            Standard 5-field cron: minute hour day-of-month month day-of-week.<br />
                            Example: <code>0 10 * * 1-5</code> runs at 10:00 UTC, Monday–Friday.
                          </span>
                        }
                        side="top"
                      />
                    </span>
                    <Input
                      value={scheduleCron}
                      onChange={(e) => onScheduleCronChange(e.target.value)}
                      placeholder="e.g. 0 10 * * *"
                    />
                  </div>
                </div>
              </TabContent>
            </TabGroup>
          </div>
        )}
      </div>
    </section>
  );
}

export { EvalScheduleSection };
