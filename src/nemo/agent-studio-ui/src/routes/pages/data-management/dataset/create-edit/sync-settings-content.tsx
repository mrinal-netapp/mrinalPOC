import { useMemo, type ReactElement } from "react";
import { useStore } from "@tanstack/react-store";
// import { IconAlertTriangle } from "@tabler/icons-react";

import type { ScheduleType } from "@/api/dataset.types";
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { SelectorWrapper } from "@/ui-lib/base-components/selector-wrapper/selector-wrapper";
import { RadioGroup } from "@/ui-lib/base-components/radio-button/radio-button";
import { FormFieldErrorBlock } from "@/ui-lib/base-components/form";
import { InputField } from "@/ui-lib/base-components/form/form-field.input";
import { CronExpressionField } from "@/ui-lib/base-components/form/form-field.cron-expression";
import { TabGroup, TabContent } from "@/ui-lib/base-components/tab/tab-group";
import { DAY_OF_WEEK_LABELS } from "@/components/dataset/utils/dataset.utils";
import { SCHEDULE_TYPE_OPTIONS } from "./form/dataset-form.consts";
import { rangeValidator } from "./sync-settings-content.utils";

// -- Types --

interface SyncSettingsContentProps {
  form: AnyReactFormApi;
  /** When true, scheduling is unavailable (manual upload datasets). */
  scheduleDisabled?: boolean;
}

const SYNC_TABS = [
  { id: "builder", label: "Use schedule builder" },
  { id: "cron", label: "Use cron expression" },
];

// -- Component --

function SyncSettingsContent({ form, scheduleDisabled = false }: SyncSettingsContentProps): ReactElement {
  const syncEnabled: boolean = useStore(form.store, (s) => s.values.sync_enabled);
  const syncScheduleMode = useStore(
    form.store,
    (s) => s.values.sync_schedule_mode,
  );
  const refreshConfig = useStore(form.store, (s) => s.values.refresh_config);
  const scheduleType: ScheduleType = refreshConfig.schedule_type;

  const activeScheduleTab = syncScheduleMode === "cron" ? "cron" : "builder";
  const dayOfWeekError = useStore(form.store, (s) => {
    const m = s.fieldMeta["refresh_config.day_of_week"];
    if (!m?.errors?.length) {
      return undefined;
    }
    return String(m.errors[0]);
  });

  const handleToggleSync = (checked: boolean): void => {
    form.setFieldValue("sync_enabled", checked);
  };

  const handleScheduleTypeChange = (val: string | string[]): void => {
    form.setFieldValue("refresh_config.schedule_type", String(val) as ScheduleType);
  };

  const handleDayOfWeekToggle = (day: number): void => {
    const current = refreshConfig.day_of_week ?? [];
    const next = current.includes(day)
      ? current.filter((d: number) => d !== day)
      : [...current, day].sort();
    form.setFieldValue("refresh_config.day_of_week", next);
  };

  const intervalValidators = useMemo(() => rangeValidator(1, 1440, "Interval"), []);
  const hourValidators = useMemo(() => rangeValidator(0, 23, "Hour"), []);
  const minuteValidators = useMemo(() => rangeValidator(0, 59, "Minute"), []);
  const dayOfMonthValidators = useMemo(() => rangeValidator(1, 31, "Day of month"), []);

  const scheduleControlsEnabled = !scheduleDisabled && syncEnabled;

  return (
    <div
      className={
        scheduleDisabled
          ? "dset-form__sync-content dset-form__sync-content--schedule-disabled"
          : "dset-form__sync-content"
      }
    >
      {/* Enable toggle */}
      <SelectorWrapper
        selectorType="checkbox"
        selectorProps={{
          checked: syncEnabled,
          onCheckedChange: handleToggleSync,
        }}
        label="Enable dataset refresh schedule"
        isDisabled={scheduleDisabled}
      />

      {!scheduleControlsEnabled && (
        <div className="dset-form__sync-notice">
          {/* Empty when sync is off; section subtitle covers upload-only messaging. */}
        </div>
      )}

      {scheduleControlsEnabled && (
        <>
          {/* Schedule builder / cron tabs */}
          <TabGroup
            tabs={SYNC_TABS}
            variant="card"
            fitting="fit-content"
            activeTabId={activeScheduleTab}
            onTabChange={(tabId) => {
              if (tabId === "cron") {
                form.setFieldValue("sync_schedule_mode", "cron");
              } else {
                form.setFieldValue("sync_schedule_mode", "builder");
              }
            }}
          >
            <TabContent tabId="builder">
              <div className="dset-form__schedule-builder">
                {/* Schedule frequency */}
                <div className="dset-form__section-header">
                  <Typography Component="h3" fontSize="fs14" boldness="semibold">Schedule frequency</Typography>
                  <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                    Select schedule frequency and configure time of the sync.
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

                {/* Title — always rendered to prevent layout jump */}
                <Typography Component="h4" fontSize="fs14" boldness="semibold">
                  {scheduleType === "hourly" ? "Configure interval" : "Time"}
                </Typography>

                {/* Hourly — interval minutes */}
                {scheduleType === "hourly" && (
                  <div className="dset-form__field">
                    <InputField
                      form={form}
                      name="refresh_config.interval_minutes"
                      label="Interval (minutes)"
                      type="text"
                      inputMode="numeric"
                      placeholder="1"
                      autoComplete="off"
                      validators={intervalValidators}
                    />
                  </div>
                )}

                {/* Daily / Weekly / Monthly — time of day */}
                {scheduleType !== "hourly" && (
                  <>
                    <div className="dset-form__time-row">
                      <div className="dset-form__field dset-form__field--half">
                        <InputField
                          form={form}
                          name="refresh_config.time_of_day_hour"
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
                          name="refresh_config.time_of_day_minute"
                          label="Minute of the hour (UTC)"
                          type="text"
                          inputMode="numeric"
                          placeholder="0"
                          autoComplete="off"
                          validators={minuteValidators}
                        />
                      </div>
                    </div>
                  </>
                )}

                {/* Weekly — day of week checkboxes */}
                {scheduleType === "weekly" && (
                  <div className="dset-form__day-checkboxes">
                    <Typography Component="label" fontSize="fs14" boldness="semibold">Day of week</Typography>
                    <div className="dset-form__day-row">
                      {DAY_OF_WEEK_LABELS.map((day) => {
                        const selected = refreshConfig.day_of_week ?? [];
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

                {/* Monthly — day of month */}
                {scheduleType === "monthly" && (
                  <div className="dset-form__field">
                    <InputField
                      form={form}
                      name="refresh_config.day_of_month"
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
                    name="refresh_config.cron_expression"
                    label="Cron expression"
                    placeholder="0 10 * * *"
                  />
                </div>
              </div>
            </TabContent>
          </TabGroup>
        </>
      )}
    </div>
  );
}

export { SyncSettingsContent };
export type { SyncSettingsContentProps };
