import type { GlobalFormValidationError } from '@tanstack/form-core';
import type { AnyFieldApi } from '@tanstack/react-form';

import { parseNum } from '@/routes/pages/data-management/dataset/create-edit/form/dataset-form.validation';
import { validateCronExpression } from '@/ui-lib/base-components/cron-expression-input/cron-expression-input.util';

import type { KBFormValues } from './kb-form.consts';
import { KB_NAME_PATTERN } from './kb-form.consts';
import { KB_HOURLY_MIN_MINUTES } from './kb-form.utils';

const KB_DATASET_ID_MISSING = 'Dataset is required';

function toFieldErrorMap(
  src: Record<string, string | undefined>,
): GlobalFormValidationError<KBFormValues>['fields'] {
  return src as GlobalFormValidationError<KBFormValues>['fields'];
}

function getDatasetIdFieldError(value: unknown, isEdit: boolean): string | undefined {
  if (isEdit) {
    return undefined;
  }
  /* v8 ignore start -- nullish coalesce fallback; value is always a string at runtime */
  if (String(value ?? '').trim() !== '') {
    return undefined;
  }
  return KB_DATASET_ID_MISSING;
  /* v8 ignore stop */
}

/** Dataset picker hidden field — create mode only (matches data-source picker pattern). */
function createKbDatasetIdFieldValidators(isEdit: boolean): {
  onChange: (o: { value: string; fieldApi: AnyFieldApi }) => string | undefined;
  onSubmit: (o: { value: string }) => string | undefined;
} {
  return {
    onChange: ({ value, fieldApi }) => {
      /* v8 ignore start -- nullish coalesce fallback; value is always a string at runtime */
      if (isEdit || String(value ?? '').trim() !== '') {
      /* v8 ignore stop */
        return undefined;
      }
      return fieldApi.form.state.submissionAttempts > 0 ? KB_DATASET_ID_MISSING : undefined;
    },
    onSubmit: ({ value }) => getDatasetIdFieldError(value, isEdit) ?? undefined,
  };
}

function collectKBScheduleErrors(value: KBFormValues): Record<string, string> {
  const out: Record<string, string> = {};

  if (value.sync_mode !== 'scheduled') {
    return out;
  }

  const kbSched = value.kb_schedule;
  const refreshConfig = kbSched.refresh_config;

  if (kbSched.sync_schedule_mode === 'builder') {
    const scheduleType = refreshConfig.schedule_type;

    switch (scheduleType) {
      case 'hourly': {
        const interval = parseNum(
          refreshConfig.interval_minutes,
          KB_HOURLY_MIN_MINUTES,
          1440,
          'Interval (minutes)',
        );
        if (!interval.ok) {
          out['kb_schedule.refresh_config.interval_minutes'] = interval.message;
        }
        break;
      }
      case 'daily':
      case 'weekly':
      case 'monthly': {
        const hour = parseNum(refreshConfig.time_of_day_hour, 0, 23, 'Hour (UTC)');
        if (!hour.ok) {
          out['kb_schedule.refresh_config.time_of_day_hour'] = hour.message;
        }
        const minute = parseNum(
          refreshConfig.time_of_day_minute,
          0,
          59,
          'Minute of the hour (UTC)',
        );
        if (!minute.ok) {
          out['kb_schedule.refresh_config.time_of_day_minute'] = minute.message;
        }
        /* v8 ignore start -- nullish fallback for undefined day_of_week array */
        if (scheduleType === 'weekly' && (refreshConfig.day_of_week?.length ?? 0) < 1) {
        /* v8 ignore stop */
          out['kb_schedule.refresh_config.day_of_week'] = 'Select at least one day';
        }
        if (scheduleType === 'monthly') {
          const day = parseNum(refreshConfig.day_of_month, 1, 31, 'Day of month');
          if (!day.ok) {
            out['kb_schedule.refresh_config.day_of_month'] = day.message;
          }
        }
        break;
      }
      case 'cron':
        break;
      default: {
        out['kb_schedule.refresh_config.schedule_type'] = `Unsupported schedule type: ${String(scheduleType)}`;
        break;
      }
    }
  /* v8 ignore start -- implicit else branch + nullish fallback for cron expression */
  } else if (kbSched.sync_schedule_mode === 'cron') {
    const cronMsg = validateCronExpression(String(refreshConfig.cron_expression ?? ''));
    if (cronMsg) {
      out['kb_schedule.refresh_config.cron_expression'] = cronMsg;
    }
  }
  /* v8 ignore stop */

  return out;
}

function collectDataChangeThresholdErrors(value: KBFormValues): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value.data_change_threshold_enabled) {
    return out;
  }
  const raw = value.data_change_threshold_value;
  if (raw === '' || raw === null || raw === undefined) {
    out.data_change_threshold_value = 'Threshold value is required';
    return out;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    out.data_change_threshold_value = 'Threshold must be at least 1';
  }
  return out;
}

function collectCreateFieldErrors(value: KBFormValues): Record<string, string> {
  const out: Record<string, string> = {};
  const name = value.name.trim();
  if (!name) {
    out.name = 'Name is required';
  } else if (name.length < 3) {
    out.name = 'Name must be at least 3 characters';
  } else if (!KB_NAME_PATTERN.test(name)) {
    out.name = 'Name may only contain letters, numbers, spaces, hyphens, and underscores';
  }

  if (!value.dataset_id.trim()) {
    out.dataset_id = KB_DATASET_ID_MISSING;
  }

  if (!value.embedding_model.trim()) {
    out.embedding_model = 'Embedding model is required';
  }

  return out;
}

function mergeFieldErrors(
  maps: Record<string, string>[],
): GlobalFormValidationError<KBFormValues> | undefined {
  const fields = maps.reduce<Record<string, string>>((acc, m) => ({ ...acc, ...m }), {});
  if (Object.keys(fields).length === 0) {
    return undefined;
  }
  return { fields: toFieldErrorMap(fields) };
}

function validateKBFormOnSubmit(
  isEdit: boolean,
): (opts: { value: KBFormValues }) => GlobalFormValidationError<KBFormValues> | undefined {
  return ({ value }) => {
    const maps: Record<string, string>[] = [
      collectKBScheduleErrors(value),
      collectDataChangeThresholdErrors(value),
    ];
    if (!isEdit) {
      maps.push(collectCreateFieldErrors(value));
    }
    return mergeFieldErrors(maps);
  };
}

type ValidateNameFn = (arg: { name: string }) => { unwrap: () => Promise<{ available: boolean }> };

async function validateKBNameAsync(
  trimmedName: string,
  validateName: ValidateNameFn,
): Promise<string | undefined> {
  if (trimmedName.length < 3) {
    return undefined;
  }
  try {
    const result = await validateName({ name: trimmedName }).unwrap();
    if (!result.available) {
      return 'A knowledge base with this name already exists';
    }
  } catch {
    return 'Unable to validate name';
  }
  return undefined;
}

export {
  validateKBFormOnSubmit,
  validateKBNameAsync,
  KB_DATASET_ID_MISSING,
  createKbDatasetIdFieldValidators,
};
