import { describe, it, expect } from "vitest";

import type { DatasetListItem } from "@/api/dataset.types";
import type { KBAssignedDataset } from "@/api/kb.types";
import {
  formatKbDatasetPickerFileScope,
  formatKbAssignedDatasetFileScope,
  getKbDatasetPickerSyncScheduleLabel,
} from "./kb-dataset-picker.utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDatasetListItem(overrides: Partial<DatasetListItem> = {}): DatasetListItem {
  return {
    dset_id: "d-1",
    name: "test-ds",
    kind: "unstructured",
    data_source: null,
    input_type: "data-source",
    status: "Healthy",
    lifecycle_status: "ready",
    deprecated: false,
    files_count: 100,
    synchronization_status: "Completed",
    latest_snapshot: null,
    labels: [],
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    modified_by: "user",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatKbDatasetPickerFileScope
// ---------------------------------------------------------------------------

describe("formatKbDatasetPickerFileScope", () => {
  it("[tag:kb][tag:dataset-picker] returns '0 files / n/a' when files_count is 0 and no snapshot", () => {
    const row = makeDatasetListItem({ files_count: 0 });
    expect(formatKbDatasetPickerFileScope(row)).toBe("0 files / n/a");
  });

  it("[tag:kb][tag:dataset-picker] returns '1 file / n/a' for singular file count", () => {
    const row = makeDatasetListItem({ files_count: 1 });
    expect(formatKbDatasetPickerFileScope(row)).toBe("1 file / n/a");
  });

  it("[tag:kb][tag:dataset-picker] returns formatted files when snapshot has total_folders", () => {
    const row = makeDatasetListItem({
      files_count: 2_500,
      latest_snapshot: {
        id: "s-1",
        version: 1,
        date: "2024-01-01T00:00:00Z",
        total_files: 2500,
        files_added: 0,
        files_removed: 0,
        total_folders: 15,
      },
    });
    expect(formatKbDatasetPickerFileScope(row)).toBe("2,500 files / 15 folders");
  });

  it("[tag:kb][tag:dataset-picker] returns singular folder when total_folders is 1", () => {
    const row = makeDatasetListItem({
      files_count: 10,
      latest_snapshot: {
        id: "s-1",
        version: 1,
        date: "2024-01-01T00:00:00Z",
        total_files: 10,
        files_added: 0,
        files_removed: 0,
        total_folders: 1,
      },
    });
    expect(formatKbDatasetPickerFileScope(row)).toBe("10 files / 1 folder");
  });

  it("[tag:kb][tag:dataset-picker] handles 0 total_folders correctly", () => {
    const row = makeDatasetListItem({
      files_count: 5,
      latest_snapshot: {
        id: "s-1",
        version: 1,
        date: "2024-01-01T00:00:00Z",
        total_files: 5,
        files_added: 0,
        files_removed: 0,
        total_folders: 0,
      },
    });
    expect(formatKbDatasetPickerFileScope(row)).toBe("5 files / 0 folders");
  });
});

// ---------------------------------------------------------------------------
// formatKbAssignedDatasetFileScope
// ---------------------------------------------------------------------------

describe("formatKbAssignedDatasetFileScope", () => {
  it("[tag:kb][tag:dataset-picker] returns '100 files / n/a' for numeric string file_scope", () => {
    const dataset: KBAssignedDataset = { file_scope: "100" };
    expect(formatKbAssignedDatasetFileScope(dataset)).toBe("100 files / n/a");
  });

  it("[tag:kb][tag:dataset-picker] returns '1 file / n/a' for file_scope '1'", () => {
    const dataset: KBAssignedDataset = { file_scope: "1" };
    expect(formatKbAssignedDatasetFileScope(dataset)).toBe("1 file / n/a");
  });

  it("[tag:kb][tag:dataset-picker] returns '0 files / n/a' for non-numeric file_scope", () => {
    const dataset: KBAssignedDataset = { file_scope: "abc" };
    expect(formatKbAssignedDatasetFileScope(dataset)).toBe("0 files / n/a");
  });

  it("[tag:kb][tag:dataset-picker] returns '0 files / n/a' when file_scope is undefined", () => {
    const dataset: KBAssignedDataset = {};
    expect(formatKbAssignedDatasetFileScope(dataset)).toBe("0 files / n/a");
  });
});

// ---------------------------------------------------------------------------
// getKbDatasetPickerSyncScheduleLabel
// ---------------------------------------------------------------------------

describe("getKbDatasetPickerSyncScheduleLabel", () => {
  it("[tag:kb][tag:dataset-picker] returns placeholder '—'", () => {
    expect(getKbDatasetPickerSyncScheduleLabel()).toBe("—");
  });
});
