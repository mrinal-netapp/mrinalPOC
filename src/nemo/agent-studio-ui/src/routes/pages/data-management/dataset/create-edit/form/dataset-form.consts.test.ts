import { describe, it, expect } from "vitest";
import type { DatasetDetail } from "@/api/dataset.types";
import {
  getScopeAvailability,
  isDataSourceCompatibleWithDatasetKind,
  isFileScopeAvailableForKind,
  isFolderScopeAvailableForSource,
  toDataSourceOriginKind,
} from "./dataset-form.consts";
import {
  buildDefaultValues,
  buildSpecPayload,
  buildRefreshConfigPayload,
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

describe("isDataSourceCompatibleWithDatasetKind", () => {
  it("allows volume and object store for unstructured datasets", () => {
    expect(isDataSourceCompatibleWithDatasetKind("Volume", "unstructured")).toBe(true);
    expect(isDataSourceCompatibleWithDatasetKind("Object Store", "unstructured")).toBe(true);
    expect(isDataSourceCompatibleWithDatasetKind("Volume", "")).toBe(true);
  });

  it("allows database and storage system for structured datasets", () => {
    expect(isDataSourceCompatibleWithDatasetKind("Database", "structured")).toBe(true);
    expect(isDataSourceCompatibleWithDatasetKind("Storage System", "structured")).toBe(true);
  });

  it("rejects cross-kind categories", () => {
    expect(isDataSourceCompatibleWithDatasetKind("Database", "unstructured")).toBe(false);
    expect(isDataSourceCompatibleWithDatasetKind("Volume", "structured")).toBe(false);
    expect(isDataSourceCompatibleWithDatasetKind("Object Store", "structured")).toBe(false);
    expect(isDataSourceCompatibleWithDatasetKind("Storage System", "unstructured")).toBe(false);
  });

  it("rejects API category", () => {
    expect(isDataSourceCompatibleWithDatasetKind("API", "structured")).toBe(false);
    expect(isDataSourceCompatibleWithDatasetKind("API", "unstructured")).toBe(false);
  });

  it("treats null/undefined category as compatible (taxonomy unavailable)", () => {
    expect(isDataSourceCompatibleWithDatasetKind(null, "unstructured")).toBe(true);
    expect(isDataSourceCompatibleWithDatasetKind(undefined, "unstructured")).toBe(true);
    expect(isDataSourceCompatibleWithDatasetKind(null, "structured")).toBe(true);
    expect(isDataSourceCompatibleWithDatasetKind(undefined, "")).toBe(true);
  });
});

describe("getScopeAvailability", () => {
  it("enables folder and file scope for volume and object store sources", () => {
    expect(getScopeAvailability("Volume")).toEqual({ folder: true, file: true, schema: false });
    expect(getScopeAvailability("Object Store")).toEqual({ folder: true, file: true, schema: false });
  });

  it("enables schema scope only for database sources", () => {
    expect(getScopeAvailability("Database")).toEqual({ folder: false, file: false, schema: true });
  });

  it("disables all scopes for storage system and API sources", () => {
    expect(getScopeAvailability("Storage System")).toEqual({ folder: false, file: false, schema: false });
    expect(getScopeAvailability("API")).toEqual({ folder: false, file: false, schema: false });
  });

  it("allows all scopes when category is unknown", () => {
    expect(getScopeAvailability(null)).toEqual({ folder: true, file: true, schema: true });
    expect(getScopeAvailability(undefined)).toEqual({ folder: true, file: true, schema: true });
  });
});

describe("isFileScopeAvailableForKind", () => {
  const volumeScope = getScopeAvailability("Volume");

  it("enables file scope for unstructured datasets on file-capable sources", () => {
    expect(isFileScopeAvailableForKind("unstructured", volumeScope)).toBe(true);
  });

  it("disables file scope for structured datasets", () => {
    expect(isFileScopeAvailableForKind("structured", volumeScope)).toBe(false);
  });

  it("disables file scope when kind is not yet chosen", () => {
    expect(isFileScopeAvailableForKind("", volumeScope)).toBe(false);
  });

  it("disables file scope when the data source does not support it", () => {
    const dbScope = getScopeAvailability("Database");
    expect(isFileScopeAvailableForKind("unstructured", dbScope)).toBe(false);
  });
});

describe("isFolderScopeAvailableForSource", () => {
  const volumeScope = getScopeAvailability("Volume");
  const objectStoreScope = getScopeAvailability("Object Store");
  const dbScope = getScopeAvailability("Database");

  it("enables folder scope for NFS volumes", () => {
    expect(isFolderScopeAvailableForSource(volumeScope, "NFS")).toBe(true);
  });

  it("disables folder scope for SMB and S3 volumes", () => {
    expect(isFolderScopeAvailableForSource(volumeScope, "SMB")).toBe(false);
    expect(isFolderScopeAvailableForSource(volumeScope, "S3")).toBe(false);
  });

  it("disables folder scope for object stores (always S3)", () => {
    expect(isFolderScopeAvailableForSource(objectStoreScope, "S3")).toBe(false);
  });

  it("stays permissive while the source protocol hasn't loaded yet", () => {
    expect(isFolderScopeAvailableForSource(volumeScope, null)).toBe(true);
    expect(isFolderScopeAvailableForSource(volumeScope, undefined)).toBe(true);
  });

  it("disables folder scope when the category itself doesn't support it, regardless of protocol", () => {
    expect(isFolderScopeAvailableForSource(dbScope, "NFS")).toBe(false);
  });
});

describe("toDataSourceOriginKind", () => {
  it("maps volume sources to volume origin", () => {
    expect(toDataSourceOriginKind("Volume")).toBe("volume");
  });

  it("maps non-volume categories to connector origin", () => {
    expect(toDataSourceOriginKind("Object Store")).toBe("connector");
    expect(toDataSourceOriginKind("Database")).toBe("connector");
  });

  it("returns undefined when category is missing", () => {
    expect(toDataSourceOriginKind(null)).toBeUndefined();
    expect(toDataSourceOriginKind(undefined)).toBeUndefined();
  });
});

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
});
