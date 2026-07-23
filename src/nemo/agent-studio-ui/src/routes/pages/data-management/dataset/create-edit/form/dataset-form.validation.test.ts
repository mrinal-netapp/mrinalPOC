import { describe, expect, it } from "vitest"

import type { AnyFieldApi } from "@tanstack/react-form"

import type { DatasetFormValues } from "./dataset-form.consts"
import {
  DATA_SOURCE_ID_MISSING,
  dataSourceIdFieldValidators,
  getDataSourceIdFieldError,
  parseNum,
  schemaQueryFieldValidators,
  validateDatasetFormOnSubmit,
  validateSqlQuery,
  validateSyncSettingsDialogOnSubmit,
} from "./dataset-form.validation"

function makeValues(overrides: Partial<DatasetFormValues> = {}): DatasetFormValues {
  return {
    input_type: "data-source",
    kind: "unstructured",
    name: "test-dataset",
    description: "",
    labels: [],
    data_source_id: "id-1",
    data_source_category: null,
    uploaded_files: [],
    spec: {
      folder_scope: "all",
      paths: [],
      file_types: "",
      last_modified_filter: "all",
      max_file_size_bytes: "",
      size_unit: "MB",
      exclude_patterns: "",
    },
    resource_selector: [],
    schema_query: "",
    sync_enabled: false,
    sync_schedule_mode: "builder",
    refresh_config: {
      schedule_type: "daily",
      interval_minutes: 60,
      time_of_day_hour: 9,
      time_of_day_minute: 0,
      day_of_week: [1],
      day_of_month: 1,
      cron_expression: "0 9 * * *",
      paused: false,
    },
    ...overrides,
  }
}

describe("parseNum", () => {
  it("rejects undefined/null as required", () => {
    expect(parseNum(undefined, 0, 10, "X")).toEqual({ ok: false, message: "X is required." })
    expect(parseNum(null, 0, 10, "X")).toEqual({ ok: false, message: "X is required." })
  })

  it("treats blank or lone-minus strings as required", () => {
    expect(parseNum("", 0, 10, "X")).toEqual({ ok: false, message: "X is required." })
    expect(parseNum("   ", 0, 10, "X")).toEqual({ ok: false, message: "X is required." })
    expect(parseNum("-", 0, 10, "X")).toEqual({ ok: false, message: "X is required." })
  })

  it("rejects non-numeric strings", () => {
    expect(parseNum("abc", 0, 10, "X")).toEqual({ ok: false, message: "X must be a number." })
  })

  it("enforces the inclusive range", () => {
    expect(parseNum(-1, 0, 10, "X")).toEqual({ ok: false, message: "X must be between 0 and 10." })
    expect(parseNum(11, 0, 10, "X")).toEqual({ ok: false, message: "X must be between 0 and 10." })
  })

  it("accepts valid numbers and numeric strings", () => {
    expect(parseNum(5, 0, 10, "X")).toEqual({ ok: true, n: 5 })
    expect(parseNum(" 7 ", 0, 10, "X")).toEqual({ ok: true, n: 7 })
  })
})

describe("validateSqlQuery", () => {
  it("treats an empty query as no error", () => {
    expect(validateSqlQuery("")).toBeUndefined()
    expect(validateSqlQuery("   ")).toBeUndefined()
    expect(validateSqlQuery(undefined)).toBeUndefined()
  })

  it("requires the query to start with SELECT or WITH", () => {
    expect(validateSqlQuery("UPDATE t SET x = 1")).toBe("Query must start with SELECT (or WITH).")
    expect(validateSqlQuery("WITH cte AS (SELECT 1) SELECT * FROM cte")).toBeUndefined()
  })

  it("blocks forbidden keywords outside string literals", () => {
    expect(validateSqlQuery("SELECT * FROM t; DROP TABLE t")).toBe(
      "Only read-only SELECT queries are allowed.",
    )
  })

  it("allows forbidden words that only appear inside string literals", () => {
    expect(validateSqlQuery("SELECT 'drop' AS note")).toBeUndefined()
  })

  it("flags unbalanced parentheses", () => {
    expect(validateSqlQuery("SELECT * FROM t)")).toBe("Unbalanced parentheses in query.")
    expect(validateSqlQuery("SELECT (1")).toBe("Unbalanced parentheses in query.")
  })

  it("flags unterminated string literals", () => {
    expect(validateSqlQuery("SELECT 'oops")).toBe(
      "Unterminated string literal — check your quotes.",
    )
  })

  it("flags multiple statements but ignores a single trailing semicolon", () => {
    expect(validateSqlQuery("SELECT 1; SELECT 2")).toBe(
      "Only a single SELECT statement is allowed.",
    )
    expect(validateSqlQuery("SELECT 1;")).toBeUndefined()
  })

  it("allows a semicolon inside a string literal", () => {
    expect(validateSqlQuery("SELECT ';' AS sep")).toBeUndefined()
  })

  it("accepts a well-formed read-only query", () => {
    expect(validateSqlQuery("SELECT id, name FROM users WHERE active = 1")).toBeUndefined()
  })

  it("accepts a leading database comment before SELECT (legacy wizard format)", () => {
    expect(
      validateSqlQuery('-- Database: sakila\nSELECT * FROM "sakila"."customer"'),
    ).toBeUndefined()
  })

  it("ignores forbidden keywords and punctuation in leading comments", () => {
    expect(validateSqlQuery("-- DROP\nSELECT 1")).toBeUndefined()
    expect(validateSqlQuery("-- (broken\nSELECT 1")).toBeUndefined()
    expect(validateSqlQuery("/* DROP ( */ SELECT 1")).toBeUndefined()
  })

  it("is exposed via the schema query field validators", () => {
    expect(schemaQueryFieldValidators.onBlur({ value: "DELETE FROM t", fieldApi: {} as AnyFieldApi })).toBe(
      "Query must start with SELECT (or WITH).",
    )
    expect(
      schemaQueryFieldValidators.onSubmit({
        value: "SELECT 1",
        fieldApi: {
          form: { state: { values: makeValues({ kind: "structured" }) } },
        } as unknown as AnyFieldApi,
      }),
    ).toBeUndefined()
  })
})

describe("getDataSourceIdFieldError", () => {
  it("only applies in data-source mode", () => {
    expect(getDataSourceIdFieldError("", "upload")).toBeUndefined()
  })

  it("passes when a non-empty id is present", () => {
    expect(getDataSourceIdFieldError("abc", "data-source")).toBeUndefined()
  })

  it("fails when the id is empty in data-source mode", () => {
    expect(getDataSourceIdFieldError("  ", "data-source")).toBe(DATA_SOURCE_ID_MISSING)
  })
})

describe("dataSourceIdFieldValidators", () => {
  const makeFieldApi = (
    input_type: DatasetFormValues["input_type"],
    submissionAttempts: number,
  ) =>
    ({
      form: { state: { values: { input_type }, submissionAttempts } },
    }) as unknown as AnyFieldApi

  it("onChange passes immediately when a value is present", () => {
    expect(
      dataSourceIdFieldValidators.onChange({
        value: "abc",
        fieldApi: makeFieldApi("data-source", 0),
      }),
    ).toBeUndefined()
  })

  it("onChange ignores empty value outside data-source mode", () => {
    expect(
      dataSourceIdFieldValidators.onChange({
        value: "",
        fieldApi: makeFieldApi("upload", 5),
      }),
    ).toBeUndefined()
  })

  it("onChange suppresses the error before the first submit attempt", () => {
    expect(
      dataSourceIdFieldValidators.onChange({
        value: "",
        fieldApi: makeFieldApi("data-source", 0),
      }),
    ).toBeUndefined()
  })

  it("onChange surfaces the error after a submit attempt", () => {
    expect(
      dataSourceIdFieldValidators.onChange({
        value: "",
        fieldApi: makeFieldApi("data-source", 1),
      }),
    ).toBe(DATA_SOURCE_ID_MISSING)
  })

  it("onSubmit always validates", () => {
    expect(
      dataSourceIdFieldValidators.onSubmit({
        value: "",
        fieldApi: makeFieldApi("data-source", 0),
      }),
    ).toBe(DATA_SOURCE_ID_MISSING)
    expect(
      dataSourceIdFieldValidators.onSubmit({
        value: "ok",
        fieldApi: makeFieldApi("data-source", 0),
      }),
    ).toBeUndefined()
  })
})

describe("validateDatasetFormOnSubmit — spec paths and schema query", () => {
  it("requires dataset kind to be selected", () => {
    const result = validateDatasetFormOnSubmit({ value: makeValues({ kind: "" }) })
    expect(result?.fields).toMatchObject({ kind: "Dataset kind is required." })
  })

  it("requires structured kind when metric categories are selected", () => {
    const result = validateDatasetFormOnSubmit({
      value: makeValues({
        kind: "unstructured",
        resource_selector: [{ category: "cpu", service: "ec2" }],
      }),
    })
    expect(result?.fields).toMatchObject({
      kind: 'Datasets that select metric categories must have kind="structured"',
    })
  })

  it("returns undefined when everything is valid", () => {
    expect(validateDatasetFormOnSubmit({ value: makeValues() })).toBeUndefined()
  })

  it("requires at least one custom folder path", () => {
    const result = validateDatasetFormOnSubmit({
      value: makeValues({
        spec: { ...makeValues().spec, folder_scope: "custom", paths: ["  "] },
      }),
    })
    expect(result?.fields).toMatchObject({ "spec.paths": "Add at least one folder path" })
  })

  it("accepts a non-empty custom folder path", () => {
    expect(
      validateDatasetFormOnSubmit({
        value: makeValues({
          spec: { ...makeValues().spec, folder_scope: "custom", paths: ["/data"] },
        }),
      }),
    ).toBeUndefined()
  })

  it("rejects multiple custom folder paths", () => {
    const result = validateDatasetFormOnSubmit({
      value: makeValues({
        spec: { ...makeValues().spec, folder_scope: "custom", paths: ["/a", "/b"] },
      }),
    })
    expect(result?.fields).toMatchObject({
      "spec.paths": "Only one scope entry is allowed. The latest selection replaces the previous one.",
    })
  })

  it("rejects multiple database table scope entries", () => {
    const result = validateDatasetFormOnSubmit({
      value: makeValues({
        kind: "structured",
        data_source_category: "Database",
        resource_selector: [
          { database: "sakila", schema: "sakila", table: "actor" },
          { database: "sakila", schema: "sakila", table: "film" },
        ],
        schema_query: "SELECT 1",
      }),
    })
    expect(result?.fields).toMatchObject({
      resource_selector: "Only one scope entry is allowed. The latest selection replaces the previous one.",
    })
  })

  it("allows multiple ONTAP resource selector entries", () => {
    expect(
      validateDatasetFormOnSubmit({
        value: makeValues({
          kind: "structured",
          resource_selector: [
            { category: "volume_metrics", svm_uuid: "svm-1" },
            { category: "volume_metrics", svm_uuid: "svm-2" },
          ],
        }),
      }),
    ).toBeUndefined()
  })

  it("surfaces schema query errors", () => {
    const result = validateDatasetFormOnSubmit({
      value: makeValues({ schema_query: "DROP TABLE t" }),
    })
    expect(result?.fields).toHaveProperty("schema_query")
  })

  it("requires a schema query when kind is structured", () => {
    const result = validateDatasetFormOnSubmit({
      value: makeValues({ kind: "structured", schema_query: "" }),
    })
    expect(result?.fields).toMatchObject({
      schema_query: "A schema-scope SQL query is required for structured datasets.",
    })
  })

  it("requires a database scope entry for structured database datasets", () => {
    const result = validateDatasetFormOnSubmit({
      value: makeValues({
        kind: "structured",
        data_source_category: "Database",
        resource_selector: [],
        schema_query: "SELECT 1",
      }),
    })
    expect(result?.fields).toMatchObject({
      resource_selector: "Select at least one table or view in Data source scope.",
    })
  })

  it("requires a name on create", () => {
    const result = validateDatasetFormOnSubmit({
      value: makeValues({ name: "" }),
    })
    expect(result?.fields).toMatchObject({ name: "Name is required" })
  })

  it("rejects names with invalid characters", () => {
    const result = validateDatasetFormOnSubmit({
      value: makeValues({ name: "abc def" }),
    })
    expect(result?.fields).toMatchObject({
      name: "Name can only contain lowercase letters (a-z), numbers (0-9), underscores (_), and hyphens (-).",
    })
  })

  it("rejects names that do not start with a letter or underscore", () => {
    const result = validateDatasetFormOnSubmit({
      value: makeValues({ name: "1abc" }),
    })
    expect(result?.fields).toMatchObject({
      name: "Name must start with a letter (a-z) or underscore (_).",
    })
  })

  it("skips name validation in edit mode", () => {
    expect(
      validateDatasetFormOnSubmit({
        value: makeValues({ name: "Existing Dataset" }),
        isEdit: true,
      }),
    ).toBeUndefined()
  })

  it("accepts structured kind without schema query when metric categories are selected", () => {
    expect(
      validateDatasetFormOnSubmit({
        value: makeValues({
          kind: "structured",
          schema_query: "",
          resource_selector: [{ category: "cpu", service: "ec2" }],
        }),
      }),
    ).toBeUndefined()
  })

  it("accepts structured kind with a valid schema query", () => {
    expect(
      validateDatasetFormOnSubmit({
        value: makeValues({
          kind: "structured",
          schema_query: "SELECT id FROM users",
        }),
      }),
    ).toBeUndefined()
  })
})

describe("collectSyncScheduleErrors via the dialog validator", () => {
  it("returns undefined when sync is disabled", () => {
    expect(
      validateSyncSettingsDialogOnSubmit({ value: makeValues({ sync_enabled: false }) }),
    ).toBeUndefined()
  })

  it("returns undefined for upload datasets even when sync is enabled", () => {
    expect(
      validateSyncSettingsDialogOnSubmit({
        value: makeValues({
          input_type: "upload",
          sync_enabled: true,
          refresh_config: {
            ...makeValues().refresh_config,
            schedule_type: "hourly",
            interval_minutes: 0,
          },
        }),
      }),
    ).toBeUndefined()
  })

  it("validates the hourly interval", () => {
    const result = validateSyncSettingsDialogOnSubmit({
      value: makeValues({
        sync_enabled: true,
        refresh_config: {
          ...makeValues().refresh_config,
          schedule_type: "hourly",
          interval_minutes: 0,
        },
      }),
    })
    expect(result?.fields).toHaveProperty("refresh_config.interval_minutes")
  })

  it("validates daily hour and minute", () => {
    const result = validateSyncSettingsDialogOnSubmit({
      value: makeValues({
        sync_enabled: true,
        refresh_config: {
          ...makeValues().refresh_config,
          schedule_type: "daily",
          time_of_day_hour: 99,
          time_of_day_minute: 99,
        },
      }),
    })
    expect(result?.fields).toHaveProperty("refresh_config.time_of_day_hour")
    expect(result?.fields).toHaveProperty("refresh_config.time_of_day_minute")
  })

  it("requires at least one weekday for weekly", () => {
    const result = validateSyncSettingsDialogOnSubmit({
      value: makeValues({
        sync_enabled: true,
        refresh_config: {
          ...makeValues().refresh_config,
          schedule_type: "weekly",
          day_of_week: [],
        },
      }),
    })
    expect(result?.fields).toMatchObject({
      "refresh_config.day_of_week": "Select at least one day",
    })
  })

  it("validates the day of month for monthly", () => {
    const result = validateSyncSettingsDialogOnSubmit({
      value: makeValues({
        sync_enabled: true,
        refresh_config: {
          ...makeValues().refresh_config,
          schedule_type: "monthly",
          day_of_month: 40,
        },
      }),
    })
    expect(result?.fields).toHaveProperty("refresh_config.day_of_month")
  })

  it("passes a valid builder schedule", () => {
    expect(
      validateSyncSettingsDialogOnSubmit({
        value: makeValues({ sync_enabled: true }),
      }),
    ).toBeUndefined()
  })

  it("validates the cron expression in cron mode", () => {
    const bad = validateSyncSettingsDialogOnSubmit({
      value: makeValues({
        sync_enabled: true,
        sync_schedule_mode: "cron",
        refresh_config: { ...makeValues().refresh_config, cron_expression: "not a cron" },
      }),
    })
    expect(bad?.fields).toHaveProperty("refresh_config.cron_expression")

    expect(
      validateSyncSettingsDialogOnSubmit({
        value: makeValues({
          sync_enabled: true,
          sync_schedule_mode: "cron",
          refresh_config: { ...makeValues().refresh_config, cron_expression: "0 9 * * *" },
        }),
      }),
    ).toBeUndefined()
  })
})
