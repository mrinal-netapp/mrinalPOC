import { describe, it, expect } from "vitest";
import type { DatasetDetail } from "@/api/dataset.types";
import {
  buildDefaultValues,
  buildSpecPayload,
  buildRefreshConfigPayload,
  buildEditDelta,
  maxFileSizeBytesToFormDisplay,
} from "./dataset-form.utils";

const BASE_DETAIL: DatasetDetail = {
  dset_id: "dset-1",
  name: "My Dataset",
  kind: "unstructured",
  input_type: "data-source",
  status: "Healthy",
  lifecycle_status: "ready",
  deprecated: false,
  files_count: 42,
  synchronization_status: "Completed",
  latest_snapshot: null,
  labels: ["staging", "nfs"],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  modified_by: "admin",
  data_source: { dsrc_id: "ds-1", name: "My Source" },
  description: "Test dataset",
  spec: {
    folder_scope: "custom",
    paths: ["/data/docs"],
    file_types: ["pdf", "txt"],
    last_modified_filter: "30d",
    max_file_size_bytes: 500_000_000,
    exclude_patterns: ["*.tmp"],
  },
  refresh_config: {
    auto_refresh_enabled: true,
    schedule_type: "daily",
    interval_minutes: undefined,
    time_of_day: "10:15",
    day_of_week: null,
    day_of_month: null,
    timezone: null,
    cron_expression: null,
    paused: false,
  },
  synchronization_summary: null,
};

describe("buildDefaultValues", () => {
  it("no initialData returns default empty form values", () => {
    const values = buildDefaultValues();

    expect(values.input_type).toBe("data-source");
    expect(values.kind).toBe("unstructured");
    expect(values.name).toBe("");
    expect(values.description).toBe("");
    expect(values.labels).toEqual([]);
    expect(values.data_source_id).toBe("");
    expect(values.uploaded_files).toEqual([]);
    expect(values.spec.folder_scope).toBe("all");
    expect(values.spec.paths).toEqual(["/"]);
    expect(values.spec.file_types).toBe("");
    expect(values.sync_enabled).toBe(false);
    expect(values.sync_schedule_mode).toBe("builder");
    expect(values.refresh_config.schedule_type).toBe("daily");
    expect(values.refresh_config.interval_minutes).toBe(1);
    expect(values.refresh_config.time_of_day_hour).toBe(0);
    expect(values.refresh_config.time_of_day_minute).toBe(0);
    expect(values.refresh_config.day_of_month).toBe(1);
  });

  it("initialData maps all top-level fields", () => {
    const values = buildDefaultValues(BASE_DETAIL);

    expect(values.name).toBe("My Dataset");
    expect(values.input_type).toBe("data-source");
    expect(values.description).toBe("Test dataset");
    expect(values.labels).toEqual(["staging", "nfs"]);
    expect(values.data_source_id).toBe("ds-1");
  });

  it("initialData with volume origin kind pre-hydrates data_source_category", () => {
    const values = buildDefaultValues({
      ...BASE_DETAIL,
      data_source_origin_kind: "volume",
    });
    expect(values.data_source_category).toBe("Volume");
  });

  it("initialData with connector origin kind leaves category null until source fetch", () => {
    const values = buildDefaultValues({
      ...BASE_DETAIL,
      data_source_origin_kind: "connector",
    });
    expect(values.data_source_category).toBeNull();
  });

  it("initialData maps spec fields", () => {
    const values = buildDefaultValues(BASE_DETAIL);

    expect(values.spec.folder_scope).toBe("custom");
    expect(values.spec.paths).toEqual(["/data/docs"]);
    expect(values.spec.file_types).toBe("pdf, txt");
    expect(values.spec.last_modified_filter).toBe("30d");
    expect(values.spec.max_file_size_bytes).toBe("500");
    expect(values.spec.size_unit).toBe("MB");
    expect(values.spec.exclude_patterns).toBe("*.tmp");
  });

  it("initialData maps refresh config and parses time_of_day", () => {
    const values = buildDefaultValues(BASE_DETAIL);

    expect(values.sync_enabled).toBe(true);
    expect(values.sync_schedule_mode).toBe("builder");
    expect(values.refresh_config.schedule_type).toBe("daily");
    expect(values.refresh_config.time_of_day_hour).toBe(10);
    expect(values.refresh_config.time_of_day_minute).toBe(15);
    expect(values.refresh_config.paused).toBe(false);
  });

  it("null description coalesces to empty string", () => {
    const values = buildDefaultValues({ ...BASE_DETAIL, description: null });
    expect(values.description).toBe("");
  });

  it("null spec coalesces to defaults", () => {
    const values = buildDefaultValues({ ...BASE_DETAIL, spec: null });
    expect(values.spec.folder_scope).toBe("all");
    expect(values.spec.paths).toEqual(["/"]);
  });

  it("null refresh_config yields sync_enabled false", () => {
    const values = buildDefaultValues({ ...BASE_DETAIL, refresh_config: null });
    expect(values.sync_enabled).toBe(false);
  });

  it("maps time_of_day with zero-hour and zero-minute (|| 0 falsy branch in parseTimeOfDay)", () => {
    // Covers `Number(parts[0]) || 0` and `Number(parts[1]) || 0` falsy branches
    const values = buildDefaultValues({
      ...BASE_DETAIL,
      refresh_config: { ...BASE_DETAIL.refresh_config!, time_of_day: "0:00" },
    });
    expect(values.refresh_config.time_of_day_hour).toBe(0);
    expect(values.refresh_config.time_of_day_minute).toBe(0);
  });

  it("null data_source coalesces data_source_id to empty string", () => {
    const values = buildDefaultValues({ ...BASE_DETAIL, data_source: null });
    expect(values.data_source_id).toBe("");
  });

  it("API schedule_type cron maps to cron tab and builder uses daily for radios", () => {
    const values = buildDefaultValues({
      ...BASE_DETAIL,
      refresh_config: {
        auto_refresh_enabled: true,
        schedule_type: "cron",
        interval_minutes: undefined,
        time_of_day: null,
        day_of_week: null,
        day_of_month: null,
        timezone: null,
        cron_expression: "0 8 * * *",
        paused: false,
      },
    });

    expect(values.sync_schedule_mode).toBe("cron");
    expect(values.refresh_config.schedule_type).toBe("daily");
    expect(values.refresh_config.cron_expression).toBe("0 8 * * *");
  });
});

describe("maxFileSizeBytesToFormDisplay", () => {
  it("returns empty value and default MB for null, zero, and invalid", () => {
    expect(maxFileSizeBytesToFormDisplay(null)).toEqual({ value: "", size_unit: "MB" });
    expect(maxFileSizeBytesToFormDisplay(undefined)).toEqual({ value: "", size_unit: "MB" });
    expect(maxFileSizeBytesToFormDisplay(0)).toEqual({ value: "", size_unit: "MB" });
    expect(maxFileSizeBytesToFormDisplay(-1)).toEqual({ value: "", size_unit: "MB" });
  });

  it("prefers GB when evenly divisible", () => {
    expect(maxFileSizeBytesToFormDisplay(1_000_000_000)).toEqual({ value: "1", size_unit: "GB" });
    expect(maxFileSizeBytesToFormDisplay(3_000_000_000)).toEqual({ value: "3", size_unit: "GB" });
  });

  it("uses MB when not a whole GB but a whole MB", () => {
    expect(maxFileSizeBytesToFormDisplay(500_000_000)).toEqual({ value: "500", size_unit: "MB" });
    expect(maxFileSizeBytesToFormDisplay(1_000_000)).toEqual({ value: "1", size_unit: "MB" });
  });

  it("uses KB for remaining byte counts (integer KB when possible)", () => {
    expect(maxFileSizeBytesToFormDisplay(1_500_000)).toEqual({ value: "1500", size_unit: "KB" });
    expect(maxFileSizeBytesToFormDisplay(1_000)).toEqual({ value: "1", size_unit: "KB" });
  });

  it("uses fractional KB when not aligned to 1000 B", () => {
    expect(maxFileSizeBytesToFormDisplay(1_500)).toEqual({ value: "1.5", size_unit: "KB" });
  });
});

describe("buildSpecPayload", () => {
  it("builds spec with all scope (no paths)", () => {
    const values = buildDefaultValues();
    const spec = buildSpecPayload(values);

    expect(spec.folder_scope).toBe("all");
    expect(spec.paths).toBeUndefined();
  });

  it("builds spec with custom paths", () => {
    const values = buildDefaultValues(BASE_DETAIL);
    const spec = buildSpecPayload(values);

    expect(spec.folder_scope).toBe("custom");
    expect(spec.paths).toEqual(["/data/docs"]);
  });

  it("trims custom folder paths in spec payload", () => {
    const values = buildDefaultValues();
    values.spec.folder_scope = "custom";
    values.spec.paths = ["  /a  ", "/b"];
    const spec = buildSpecPayload(values);

    expect(spec.paths).toEqual(["/a", "/b"]);
  });

  it("omits empty file_types and exclude_patterns", () => {
    const values = buildDefaultValues();
    const spec = buildSpecPayload(values);

    expect(spec.file_types).toBeUndefined();
    expect(spec.exclude_patterns).toBeUndefined();
  });

  it("uses GB multiplier (1e9) when size_unit is GB", () => {
    // Covers the `size_unit === "GB" ? 1_000_000_000 : ...` true branch in buildSpecPayload
    const values = buildDefaultValues();
    values.spec.max_file_size_bytes = "2";
    values.spec.size_unit = "GB";
    const spec = buildSpecPayload(values);
    expect(spec.max_file_size_bytes).toBe(2_000_000_000);
  });

  it("uses KB multiplier (1000) when size_unit is KB", () => {
    // Covers the `size_unit === "KB" ? 1_000 : 1_000_000` true branch in buildSpecPayload
    const values = buildDefaultValues();
    values.spec.max_file_size_bytes = "512";
    values.spec.size_unit = "KB";
    const spec = buildSpecPayload(values);
    expect(spec.max_file_size_bytes).toBe(512_000);
  });

  it("includes file_types and exclude_patterns when provided", () => {
    const values = buildDefaultValues(BASE_DETAIL);
    const spec = buildSpecPayload(values);
    expect(spec.file_types).toEqual(["pdf", "txt"]);
    expect(spec.exclude_patterns).toEqual(["*.tmp"]);
  });
});

describe("buildRefreshConfigPayload", () => {
  it("returns undefined when sync is disabled", () => {
    const values = buildDefaultValues();
    expect(buildRefreshConfigPayload(values)).toBeUndefined();
  });

  it("returns config when sync is enabled", () => {
    const values = buildDefaultValues(BASE_DETAIL);
    const config = buildRefreshConfigPayload(values);

    expect(config).toBeDefined();
    expect(config!.auto_refresh_enabled).toBe(true);
    expect(config!.schedule_type).toBe("daily");
    expect(config!.time_of_day).toBe("10:15");
    expect(config!.paused).toBe(false);
  });

  it("returns interval_minutes for hourly schedule", () => {
    const values = buildDefaultValues();
    values.sync_enabled = true;
    values.sync_schedule_mode = "builder";
    values.refresh_config.schedule_type = "hourly";
    values.refresh_config.interval_minutes = 120;
    const config = buildRefreshConfigPayload(values);

    expect(config!.interval_minutes).toBe(120);
    expect(config!.time_of_day).toBeNull();
  });

  it("returns day_of_week for weekly schedule", () => {
    const values = buildDefaultValues();
    values.sync_enabled = true;
    values.sync_schedule_mode = "builder";
    values.refresh_config.schedule_type = "weekly";
    values.refresh_config.day_of_week = [1, 3, 5];
    const config = buildRefreshConfigPayload(values);

    expect(config!.day_of_week).toEqual([1, 3, 5]);
  });

  it("returns cron when sync_schedule_mode is cron", () => {
    const values = buildDefaultValues();
    values.sync_enabled = true;
    values.sync_schedule_mode = "cron";
    values.refresh_config.cron_expression = "0 10 * * *";
    const config = buildRefreshConfigPayload(values);

    expect(config!.schedule_type).toBe("cron");
    expect(config!.cron_expression).toBe("0 10 * * *");
    expect(config!.time_of_day).toBeNull();
    expect(config!.interval_minutes).toBeUndefined();
  });

  it("returns null cron_expression when cron_expression is empty (expression || null falsy branch)", () => {
    // Covers `cron_expression: expression || null` when expression is empty string
    const values = buildDefaultValues();
    values.sync_enabled = true;
    values.sync_schedule_mode = "cron";
    values.refresh_config.cron_expression = "";
    const config = buildRefreshConfigPayload(values);

    expect(config!.schedule_type).toBe("cron");
    expect(config!.cron_expression).toBeNull();
  });

  it("handles null cron_expression in cron mode (rc.cron_expression ?? '' null branch)", () => {
    // Covers `(rc.cron_expression ?? "").trim()` when cron_expression is null
    const values = buildDefaultValues();
    values.sync_enabled = true;
    values.sync_schedule_mode = "cron";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (values.refresh_config as any).cron_expression = null;
    const config = buildRefreshConfigPayload(values);

    expect(config!.schedule_type).toBe("cron");
    expect(config!.cron_expression).toBeNull();
  });

  it("returns day_of_month for monthly schedule (ternary true branch, line 190)", () => {
    // Covers `st === "monthly" ? toInt(rc.day_of_month) : null` true branch
    const values = buildDefaultValues();
    values.sync_enabled = true;
    values.sync_schedule_mode = "builder";
    values.refresh_config.schedule_type = "monthly";
    values.refresh_config.day_of_month = 15;
    const config = buildRefreshConfigPayload(values);

    expect(config!.schedule_type).toBe("monthly");
    expect(config!.day_of_month).toBe(15);
    expect(config!.day_of_week).toBeNull();
  });

  it("toInt falls back to 0 when time_of_day_hour is non-numeric (NaN branch)", () => {
    const values = buildDefaultValues();
    values.sync_enabled = true;
    values.sync_schedule_mode = "builder";
    values.refresh_config.schedule_type = "daily";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (values.refresh_config as any).time_of_day_hour = "abc";
    values.refresh_config.time_of_day_minute = 30;
    const config = buildRefreshConfigPayload(values);

    expect(config!.time_of_day).toBe("00:30");
  });

  it("toInt falls back to 0 when time_of_day_minute is non-numeric (NaN branch)", () => {
    const values = buildDefaultValues();
    values.sync_enabled = true;
    values.sync_schedule_mode = "builder";
    values.refresh_config.schedule_type = "daily";
    values.refresh_config.time_of_day_hour = 10;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (values.refresh_config as any).time_of_day_minute = "abc";
    const config = buildRefreshConfigPayload(values);

    expect(config!.time_of_day).toBe("10:00");
  });

  it("toInt falls back to 0 when interval_minutes is non-numeric (NaN branch)", () => {
    const values = buildDefaultValues();
    values.sync_enabled = true;
    values.sync_schedule_mode = "builder";
    values.refresh_config.schedule_type = "hourly";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (values.refresh_config as any).interval_minutes = "abc";
    const config = buildRefreshConfigPayload(values);

    expect(config!.interval_minutes).toBe(0);
  });

  it("toInt falls back to 0 when day_of_month is non-numeric (NaN branch)", () => {
    const values = buildDefaultValues();
    values.sync_enabled = true;
    values.sync_schedule_mode = "builder";
    values.refresh_config.schedule_type = "monthly";
    values.refresh_config.time_of_day_hour = 0;
    values.refresh_config.time_of_day_minute = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (values.refresh_config as any).day_of_month = "abc";
    const config = buildRefreshConfigPayload(values);

    expect(config!.day_of_month).toBe(0);
  });
});

describe("buildEditDelta", () => {
  it("returns empty object when nothing changed", () => {
    const values = buildDefaultValues(BASE_DETAIL);
    const delta = buildEditDelta(values, BASE_DETAIL);
    expect(delta).toEqual({});
  });

  it("includes only description when only description changed", () => {
    const values = buildDefaultValues(BASE_DETAIL);
    values.description = "Updated description";
    const delta = buildEditDelta(values, BASE_DETAIL);

    expect(delta.description).toBe("Updated description");
    expect(delta).not.toHaveProperty("labels");
    expect(delta).not.toHaveProperty("spec");
    expect(delta).not.toHaveProperty("refresh_config");
  });

  it("includes only labels when only labels changed", () => {
    const values = buildDefaultValues(BASE_DETAIL);
    values.labels = ["staging", "nfs", "new-label"];
    const delta = buildEditDelta(values, BASE_DETAIL);

    expect(delta.labels).toEqual(["staging", "nfs", "new-label"]);
    expect(delta).not.toHaveProperty("description");
    expect(delta).not.toHaveProperty("spec");
    expect(delta).not.toHaveProperty("refresh_config");
  });

  it("includes only spec when only spec changed", () => {
    const values = buildDefaultValues(BASE_DETAIL);
    values.spec.folder_scope = "all";
    const delta = buildEditDelta(values, BASE_DETAIL);

    expect(delta.spec).toBeDefined();
    expect(delta).not.toHaveProperty("description");
    expect(delta).not.toHaveProperty("labels");
    expect(delta).not.toHaveProperty("refresh_config");
  });

  it("includes only refresh_config when only sync settings changed", () => {
    const values = buildDefaultValues(BASE_DETAIL);
    values.refresh_config.schedule_type = "weekly";
    values.refresh_config.day_of_week = [1, 3];
    const delta = buildEditDelta(values, BASE_DETAIL);

    expect(delta.refresh_config).toBeDefined();
    expect(delta).not.toHaveProperty("description");
    expect(delta).not.toHaveProperty("labels");
    expect(delta).not.toHaveProperty("spec");
  });

  it("includes an explicit disabled refresh_config when sync is toggled off", () => {
    const values = buildDefaultValues(BASE_DETAIL);
    values.sync_enabled = false;
    const delta = buildEditDelta(values, BASE_DETAIL);

    // Turning the schedule off sends an explicit disabled config so the backend
    // clears the schedule (rather than a no-op undefined).
    expect(delta).toHaveProperty("refresh_config");
    expect(delta.refresh_config).toBeDefined();
    expect(delta.refresh_config?.auto_refresh_enabled).toBe(false);
  });

  it("preserves cron schedule shape when sync is toggled off", () => {
    const initial = {
      ...BASE_DETAIL,
      refresh_config: {
        auto_refresh_enabled: true,
        schedule_type: "cron" as const,
        interval_minutes: undefined,
        time_of_day: null,
        day_of_week: null,
        day_of_month: null,
        timezone: null,
        cron_expression: "0 8 * * *",
        paused: false,
      },
    };
    const values = buildDefaultValues(initial);
    values.sync_enabled = false;
    const delta = buildEditDelta(values, initial);

    expect(delta.refresh_config).toBeDefined();
    expect(delta.refresh_config?.auto_refresh_enabled).toBe(false);
    expect(delta.refresh_config?.schedule_type).toBe("cron");
    expect(delta.refresh_config?.cron_expression).toBe("0 8 * * *");
    expect(delta.refresh_config?.time_of_day).toBeNull();
    expect(delta.refresh_config?.interval_minutes).toBeUndefined();
  });

  it("includes multiple fields when multiple changed", () => {
    const values = buildDefaultValues(BASE_DETAIL);
    values.description = "New desc";
    values.labels = ["production"];
    const delta = buildEditDelta(values, BASE_DETAIL);

    expect(delta.description).toBe("New desc");
    expect(delta.labels).toEqual(["production"]);
    expect(delta).not.toHaveProperty("spec");
    expect(delta).not.toHaveProperty("refresh_config");
  });

  it("clears the description by sending an empty string", () => {
    const values = buildDefaultValues(BASE_DETAIL);
    values.description = "";
    const delta = buildEditDelta(values, BASE_DETAIL);

    // Clearing sends "" (not undefined) so the slice persists the cleared value
    // instead of dropping it as a no-op.
    expect(delta).toHaveProperty("description");
    expect(delta.description).toBe("");
  });

  it("detects label reordering as no change (sorted comparison)", () => {
    const values = buildDefaultValues(BASE_DETAIL);
    values.labels = ["nfs", "staging"];
    const delta = buildEditDelta(values, BASE_DETAIL);
    expect(delta).not.toHaveProperty("labels");
  });

  it("handles null description in initialData (clearing description)", () => {
    const initial = { ...BASE_DETAIL, description: null };
    const values = buildDefaultValues(initial);
    values.description = "Brand new";
    const delta = buildEditDelta(values, initial);
    expect(delta.description).toBe("Brand new");
  });

  it("returns empty delta when initialData.spec is null and form is untouched", () => {
    const initial = { ...BASE_DETAIL, spec: null };
    const values = buildDefaultValues(initial);
    const delta = buildEditDelta(values, initial);
    expect(delta).not.toHaveProperty("spec");
  });

  it("handles null refresh_config in initialData when sync stays disabled", () => {
    const initial = { ...BASE_DETAIL, refresh_config: null };
    const values = buildDefaultValues(initial);
    const delta = buildEditDelta(values, initial);
    expect(delta).not.toHaveProperty("refresh_config");
  });

  it("omits refresh_config changes for upload datasets", () => {
    const initial = { ...BASE_DETAIL, input_type: "upload" as const, data_source: null };
    const values = buildDefaultValues(initial);
    values.sync_enabled = true;
    values.refresh_config.schedule_type = "hourly";
    values.refresh_config.interval_minutes = 30;
    const delta = buildEditDelta(values, initial);
    expect(delta).not.toHaveProperty("refresh_config");
  });
});
