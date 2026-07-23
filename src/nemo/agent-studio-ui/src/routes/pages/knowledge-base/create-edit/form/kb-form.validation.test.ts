import { describe, it, expect, vi } from "vitest";

import type { KBFormValues } from "./kb-form.consts";
import { buildKBDefaultValues } from "./kb-form.utils";
import {
  validateKBFormOnSubmit,
  validateKBNameAsync,
  KB_DATASET_ID_MISSING,
  createKbDatasetIdFieldValidators,
} from "./kb-form.validation";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValues(overrides: Partial<KBFormValues> = {}): KBFormValues {
  return { ...buildKBDefaultValues(), ...overrides };
}

// ---------------------------------------------------------------------------
// validateKBFormOnSubmit (create mode)
// ---------------------------------------------------------------------------

describe("validateKBFormOnSubmit — create mode", () => {
  const validate = validateKBFormOnSubmit(false);

  it("[tag:kb][tag:validation] fails when name is empty", () => {
    const result = validate({ value: makeValues({ name: "" }) });
    expect(result?.fields).toHaveProperty("name", "Name is required");
  });

  it("[tag:kb][tag:validation] fails when name is too short", () => {
    const result = validate({ value: makeValues({ name: "ab" }) });
    expect(result?.fields).toHaveProperty("name", "Name must be at least 3 characters");
  });

  it("[tag:kb][tag:validation] fails when name has invalid characters", () => {
    const result = validate({ value: makeValues({ name: "test@kb!" }) });
    expect(result?.fields).toHaveProperty("name", "Name may only contain letters, numbers, spaces, hyphens, and underscores");
  });

  it("[tag:kb][tag:validation] fails when dataset_id is empty", () => {
    const result = validate({ value: makeValues({ name: "valid-name", dataset_id: "", embedding_model: "model" }) });
    expect(result?.fields).toHaveProperty("dataset_id", KB_DATASET_ID_MISSING);
  });

  it("[tag:kb][tag:validation] fails when embedding_model is empty", () => {
    const result = validate({ value: makeValues({ name: "valid-name", dataset_id: "ds-1", embedding_model: "" }) });
    expect(result?.fields).toHaveProperty("embedding_model", "Embedding model is required");
  });

  it("[tag:kb][tag:validation] passes when all create fields are valid", () => {
    const result = validate({
      value: makeValues({ name: "valid-name", dataset_id: "ds-1", embedding_model: "model" }),
    });
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateKBFormOnSubmit (edit mode)
// ---------------------------------------------------------------------------

describe("validateKBFormOnSubmit — edit mode", () => {
  const validate = validateKBFormOnSubmit(true);

  it("[tag:kb][tag:validation] skips create-only validations (name, dataset_id, embedding_model)", () => {
    const result = validate({
      value: makeValues({ name: "", dataset_id: "", embedding_model: "" }),
    });
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// collectKBScheduleErrors (tested indirectly via validateKBFormOnSubmit)
// ---------------------------------------------------------------------------

describe("collectKBScheduleErrors", () => {
  const validate = validateKBFormOnSubmit(true);

  it("[tag:kb][tag:validation] non-scheduled mode returns no schedule errors", () => {
    const result = validate({ value: makeValues({ sync_mode: "manual" }) });
    expect(result).toBeUndefined();
  });

  it("[tag:kb][tag:validation] hourly with invalid interval returns error", () => {
    const result = validate({
      value: makeValues({
        sync_mode: "scheduled",
        kb_schedule: {
          sync_schedule_mode: "builder",
          refresh_config: {
            schedule_type: "hourly",
            interval_minutes: 0,
            time_of_day_hour: 0,
            time_of_day_minute: 0,
            day_of_week: [],
            day_of_month: 1,
            cron_expression: "",
          },
        },
      }),
    });
    expect(result?.fields).toHaveProperty("kb_schedule.refresh_config.interval_minutes");
  });

  it("[tag:kb][tag:validation] daily with invalid hour returns error", () => {
    const result = validate({
      value: makeValues({
        sync_mode: "scheduled",
        kb_schedule: {
          sync_schedule_mode: "builder",
          refresh_config: {
            schedule_type: "daily",
            interval_minutes: 120,
            time_of_day_hour: 25,
            time_of_day_minute: 0,
            day_of_week: [],
            day_of_month: 1,
            cron_expression: "",
          },
        },
      }),
    });
    expect(result?.fields).toHaveProperty("kb_schedule.refresh_config.time_of_day_hour");
  });

  it("[tag:kb][tag:validation] weekly with no days selected returns error", () => {
    const result = validate({
      value: makeValues({
        sync_mode: "scheduled",
        kb_schedule: {
          sync_schedule_mode: "builder",
          refresh_config: {
            schedule_type: "weekly",
            interval_minutes: 120,
            time_of_day_hour: 9,
            time_of_day_minute: 0,
            day_of_week: [],
            day_of_month: 1,
            cron_expression: "",
          },
        },
      }),
    });
    expect(result?.fields).toHaveProperty("kb_schedule.refresh_config.day_of_week", "Select at least one day");
  });

  it("[tag:kb][tag:validation] monthly with invalid day returns error", () => {
    const result = validate({
      value: makeValues({
        sync_mode: "scheduled",
        kb_schedule: {
          sync_schedule_mode: "builder",
          refresh_config: {
            schedule_type: "monthly",
            interval_minutes: 120,
            time_of_day_hour: 0,
            time_of_day_minute: 0,
            day_of_week: [],
            day_of_month: 32,
            cron_expression: "",
          },
        },
      }),
    });
    expect(result?.fields).toHaveProperty("kb_schedule.refresh_config.day_of_month");
  });

  it("[tag:kb][tag:validation] cron with invalid expression returns error", () => {
    const result = validate({
      value: makeValues({
        sync_mode: "scheduled",
        kb_schedule: {
          sync_schedule_mode: "cron",
          refresh_config: {
            schedule_type: "daily",
            interval_minutes: 120,
            time_of_day_hour: 0,
            time_of_day_minute: 0,
            day_of_week: [],
            day_of_month: 1,
            cron_expression: "not-valid",
          },
        },
      }),
    });
    expect(result?.fields).toHaveProperty("kb_schedule.refresh_config.cron_expression");
  });

  it("[tag:kb][tag:validation] daily with invalid minute returns error", () => {
    const result = validate({
      value: makeValues({
        sync_mode: "scheduled",
        kb_schedule: {
          sync_schedule_mode: "builder",
          refresh_config: {
            schedule_type: "daily",
            interval_minutes: 120,
            time_of_day_hour: 8,
            time_of_day_minute: 99,
            day_of_week: [],
            day_of_month: 1,
            cron_expression: "",
          },
        },
      }),
    });
    expect(result?.fields).toHaveProperty("kb_schedule.refresh_config.time_of_day_minute");
  });

  it("[tag:kb][tag:validation] unsupported schedule type returns error", () => {
    const result = validate({
      value: makeValues({
        sync_mode: "scheduled",
        kb_schedule: {
          sync_schedule_mode: "builder",
          refresh_config: {
            schedule_type: "unknown_type" as never,
            interval_minutes: 120,
            time_of_day_hour: 0,
            time_of_day_minute: 0,
            day_of_week: [],
            day_of_month: 1,
            cron_expression: "",
          },
        },
      }),
    });
    expect(result?.fields).toHaveProperty(
      "kb_schedule.refresh_config.schedule_type",
      "Unsupported schedule type: unknown_type",
    );
  });

  it("[tag:kb][tag:validation] cron schedule type in builder mode hits cron case (no error)", () => {
    const result = validate({
      value: makeValues({
        sync_mode: "scheduled",
        kb_schedule: {
          sync_schedule_mode: "builder",
          refresh_config: {
            schedule_type: "cron" as never,
            interval_minutes: 120,
            time_of_day_hour: 0,
            time_of_day_minute: 0,
            day_of_week: [],
            day_of_month: 1,
            cron_expression: "",
          },
        },
      }),
    });
    expect(result).toBeUndefined();
  });

  it("[tag:kb][tag:validation] valid scheduled + builder config passes", () => {
    const result = validate({
      value: makeValues({
        sync_mode: "scheduled",
        kb_schedule: {
          sync_schedule_mode: "builder",
          refresh_config: {
            schedule_type: "daily",
            interval_minutes: 120,
            time_of_day_hour: 8,
            time_of_day_minute: 30,
            day_of_week: [],
            day_of_month: 1,
            cron_expression: "",
          },
        },
      }),
    });
    expect(result).toBeUndefined();
  });

  it("[tag:kb][tag:validation] hourly with valid interval passes", () => {
    const result = validate({
      value: makeValues({
        sync_mode: "scheduled",
        kb_schedule: {
          sync_schedule_mode: "builder",
          refresh_config: {
            schedule_type: "hourly",
            interval_minutes: 240,
            time_of_day_hour: 0,
            time_of_day_minute: 0,
            day_of_week: [],
            day_of_month: 1,
            cron_expression: "",
          },
        },
      }),
    });
    expect(result).toBeUndefined();
  });

  it("[tag:kb][tag:validation] weekly with days selected passes", () => {
    const result = validate({
      value: makeValues({
        sync_mode: "scheduled",
        kb_schedule: {
          sync_schedule_mode: "builder",
          refresh_config: {
            schedule_type: "weekly",
            interval_minutes: 120,
            time_of_day_hour: 9,
            time_of_day_minute: 0,
            day_of_week: [1, 3],
            day_of_month: 1,
            cron_expression: "",
          },
        },
      }),
    });
    expect(result).toBeUndefined();
  });

  it("[tag:kb][tag:validation] monthly with valid day passes", () => {
    const result = validate({
      value: makeValues({
        sync_mode: "scheduled",
        kb_schedule: {
          sync_schedule_mode: "builder",
          refresh_config: {
            schedule_type: "monthly",
            interval_minutes: 120,
            time_of_day_hour: 0,
            time_of_day_minute: 0,
            day_of_week: [],
            day_of_month: 15,
            cron_expression: "",
          },
        },
      }),
    });
    expect(result).toBeUndefined();
  });

  it("[tag:kb][tag:validation] cron mode with valid expression passes", () => {
    const result = validate({
      value: makeValues({
        sync_mode: "scheduled",
        kb_schedule: {
          sync_schedule_mode: "cron",
          refresh_config: {
            schedule_type: "daily",
            interval_minutes: 120,
            time_of_day_hour: 0,
            time_of_day_minute: 0,
            day_of_week: [],
            day_of_month: 1,
            cron_expression: "0 10 * * *",
          },
        },
      }),
    });
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// collectDataChangeThresholdErrors (tested indirectly)
// ---------------------------------------------------------------------------

describe("collectDataChangeThresholdErrors", () => {
  const validate = validateKBFormOnSubmit(true);

  it("[tag:kb][tag:validation] disabled threshold produces no error", () => {
    const result = validate({
      value: makeValues({ data_change_threshold_enabled: false }),
    });
    expect(result).toBeUndefined();
  });

  it("[tag:kb][tag:validation] enabled with empty value produces error", () => {
    const result = validate({
      value: makeValues({ data_change_threshold_enabled: true, data_change_threshold_value: "" }),
    });
    expect(result?.fields).toHaveProperty("data_change_threshold_value", "Threshold value is required");
  });

  it("[tag:kb][tag:validation] enabled with value below 1 produces error", () => {
    const result = validate({
      value: makeValues({ data_change_threshold_enabled: true, data_change_threshold_value: "0" }),
    });
    expect(result?.fields).toHaveProperty("data_change_threshold_value", "Threshold must be at least 1");
  });

  it("[tag:kb][tag:validation] enabled with valid value passes", () => {
    const result = validate({
      value: makeValues({ data_change_threshold_enabled: true, data_change_threshold_value: "5" }),
    });
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateKBNameAsync
// ---------------------------------------------------------------------------

describe("validateKBNameAsync", () => {
  it("[tag:kb][tag:validation] returns undefined when name is available", async () => {
    const validateName = vi.fn(() => ({
      unwrap: () => Promise.resolve({ available: true }),
    }));

    const result = await validateKBNameAsync("valid-name", validateName);
    expect(result).toBeUndefined();
    expect(validateName).toHaveBeenCalledWith({ name: "valid-name" });
  });

  it("[tag:kb][tag:validation] returns error when name is unavailable", async () => {
    const validateName = vi.fn(() => ({
      unwrap: () => Promise.resolve({ available: false }),
    }));

    const result = await validateKBNameAsync("taken-name", validateName);
    expect(result).toBe("A knowledge base with this name already exists");
  });

  it("[tag:kb][tag:validation] returns network error message on rejection", async () => {
    const validateName = vi.fn(() => ({
      unwrap: () => Promise.reject(new Error("Network error")),
    }));

    const result = await validateKBNameAsync("some-name", validateName);
    expect(result).toBe("Unable to validate name");
  });

  it("[tag:kb][tag:validation] skips validation when name is shorter than 3 chars", async () => {
    const validateName = vi.fn(() => ({
      unwrap: () => Promise.resolve({ available: true }),
    }));

    const result = await validateKBNameAsync("ab", validateName);
    expect(result).toBeUndefined();
    expect(validateName).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createKbDatasetIdFieldValidators
// ---------------------------------------------------------------------------

describe("createKbDatasetIdFieldValidators", () => {
  it("[tag:kb][tag:validation] create mode onSubmit returns error for empty value", () => {
    const validators = createKbDatasetIdFieldValidators(false);
    const result = validators.onSubmit({ value: "" });
    expect(result).toBe(KB_DATASET_ID_MISSING);
  });

  it("[tag:kb][tag:validation] edit mode onSubmit returns undefined for empty value", () => {
    const validators = createKbDatasetIdFieldValidators(true);
    const result = validators.onSubmit({ value: "" });
    expect(result).toBeUndefined();
  });

  it("[tag:kb][tag:validation] create mode onChange before submission returns undefined", () => {
    const validators = createKbDatasetIdFieldValidators(false);
    const mockFieldApi = { form: { state: { submissionAttempts: 0 } } };
    const result = validators.onChange({ value: "", fieldApi: mockFieldApi as never });
    expect(result).toBeUndefined();
  });

  it("[tag:kb][tag:validation] create mode onChange after submission returns error for empty value", () => {
    const validators = createKbDatasetIdFieldValidators(false);
    const mockFieldApi = { form: { state: { submissionAttempts: 1 } } };
    const result = validators.onChange({ value: "", fieldApi: mockFieldApi as never });
    expect(result).toBe(KB_DATASET_ID_MISSING);
  });

  it("[tag:kb][tag:validation] create mode onChange returns undefined when value is present", () => {
    const validators = createKbDatasetIdFieldValidators(false);
    const mockFieldApi = { form: { state: { submissionAttempts: 1 } } };
    const result = validators.onChange({ value: "ds-1", fieldApi: mockFieldApi as never });
    expect(result).toBeUndefined();
  });

  it("[tag:kb][tag:validation] create mode onSubmit returns undefined when value is present", () => {
    const validators = createKbDatasetIdFieldValidators(false);
    const result = validators.onSubmit({ value: "ds-1" });
    expect(result).toBeUndefined();
  });

  it("[tag:kb][tag:validation] edit mode onChange returns undefined regardless of value", () => {
    const validators = createKbDatasetIdFieldValidators(true);
    const mockFieldApi = { form: { state: { submissionAttempts: 1 } } };
    const result = validators.onChange({ value: "", fieldApi: mockFieldApi as never });
    expect(result).toBeUndefined();
  });
});
