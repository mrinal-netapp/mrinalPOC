import { describe, it, expect } from "vitest";

import type { FilterCriteria } from "@/api/analytics-api";
import {
  applyBrowseFilters,
  buildBrowseFilterCriteria,
  formatBrowseFilterLabel,
} from "./browse-filter.utils";

interface SampleRow {
  name: string;
  type: string;
  size: number;
}

function getCell(row: SampleRow, column: string): string | number | null {
  switch (column) {
    case "Name": return row.name;
    case "Type": return row.type;
    case "Size": return row.size;
    default: return null;
  }
}

const ROWS: SampleRow[] = [
  { name: "file-a.txt", type: "File", size: 100 },
  { name: "folder-b", type: "Folder", size: 0 },
  { name: "file-c.pdf", type: "File", size: 500 },
];

describe("applyBrowseFilters", () => {
  it("returns all rows when filters are empty", () => {
    expect(applyBrowseFilters(ROWS, [], getCell)).toEqual(ROWS);
  });

  it("filters rows with AND logic", () => {
    const filters: FilterCriteria[] = [
      { column: "Type", op: "LIKE", value: "%File%" },
      { column: "Name", op: "LIKE", value: "%.txt" },
    ];

    expect(applyBrowseFilters(ROWS, filters, getCell)).toEqual([
      { name: "file-a.txt", type: "File", size: 100 },
    ]);
  });

  it("supports exact numeric match", () => {
    const filters: FilterCriteria[] = [{ column: "Size", op: "=", value: "500" }];

    expect(applyBrowseFilters(ROWS, filters, getCell)).toEqual([
      { name: "file-c.pdf", type: "File", size: 500 },
    ]);
  });

  it("supports LIKE contains for timestamp values", () => {
    interface TimestampRow {
      lastModified: string;
    }

    const timestampRows: TimestampRow[] = [
      { lastModified: "2026-01-01T12:00:00Z" },
      { lastModified: "2026-01-03T12:00:00Z" },
    ];

    const getTimestampCell = (row: TimestampRow, column: string): string | null =>
      column === "Last modified" ? row.lastModified : null;

    const filters: FilterCriteria[] = [{ column: "Last modified", op: "LIKE", value: "%2026-01-03%" }];

    expect(applyBrowseFilters(timestampRows, filters, getTimestampCell)).toEqual([
      { lastModified: "2026-01-03T12:00:00Z" },
    ]);
  });

  it("rejects rows when filter operator is unsupported", () => {
    const filters = [{ column: "Size", op: "BETWEEN" as FilterCriteria["op"], value: "100,500" }];

    expect(applyBrowseFilters(ROWS, filters, getCell)).toEqual([]);
  });

  it("matches names containing literal % when user escapes wildcards", () => {
    const rows: SampleRow[] = [
      { name: "budget-100%.csv", type: "File", size: 1 },
      { name: "budget-100X.csv", type: "File", size: 2 },
    ];
    const criteria = buildBrowseFilterCriteria("Name", "100%", ["Name"], ["VARCHAR"]);
    expect(criteria).toEqual({ column: "Name", op: "LIKE", value: "%100\\%%" });

    expect(applyBrowseFilters(rows, [criteria!], getCell)).toEqual([
      { name: "budget-100%.csv", type: "File", size: 1 },
    ]);
  });

  it("matches names containing literal _ when user escapes wildcards", () => {
    const rows: SampleRow[] = [
      { name: "my_file_a.txt", type: "File", size: 1 },
      { name: "myfilea.txt", type: "File", size: 2 },
    ];
    const criteria = buildBrowseFilterCriteria("Name", "file_a", ["Name"], ["VARCHAR"]);
    expect(criteria).toEqual({ column: "Name", op: "LIKE", value: "%file\\_a%" });

    expect(applyBrowseFilters(rows, [criteria!], getCell)).toEqual([
      { name: "my_file_a.txt", type: "File", size: 1 },
    ]);
  });
});

describe("buildBrowseFilterCriteria", () => {
  const columns = ["Name", "Type", "Size", "Last modified"];
  const columnTypes = ["VARCHAR", "VARCHAR", "BIGINT", "TIMESTAMP"];

  it("returns null for empty values", () => {
    expect(buildBrowseFilterCriteria("Name", "  ", columns, columnTypes)).toBeNull();
  });

  it("uses LIKE contains for text columns", () => {
    expect(buildBrowseFilterCriteria("Name", "report", columns, columnTypes)).toEqual({
      column: "Name",
      op: "LIKE",
      value: "%report%",
    });
  });

  it("uses exact match for numeric columns", () => {
    expect(buildBrowseFilterCriteria("Size", "1024", columns, columnTypes)).toEqual({
      column: "Size",
      op: "=",
      value: "1024",
    });
  });

  it("uses LIKE contains for temporal columns", () => {
    expect(buildBrowseFilterCriteria("Last modified", "2026-01", columns, columnTypes)).toEqual({
      column: "Last modified",
      op: "LIKE",
      value: "%2026-01%",
    });
  });

  it("escapes SQL LIKE metacharacters in user literals", () => {
    expect(buildBrowseFilterCriteria("Name", "100%", columns, columnTypes)).toEqual({
      column: "Name",
      op: "LIKE",
      value: "%100\\%%",
    });
  });
});

describe("formatBrowseFilterLabel", () => {
  const columns = ["Name", "Size"];
  const columnTypes = ["VARCHAR", "BIGINT"];

  it("formats contains filters", () => {
    expect(
      formatBrowseFilterLabel({ column: "Name", op: "LIKE", value: "%report%" }, columns, columnTypes),
    ).toBe("Name contains report");
  });

  it("formats exact filters", () => {
    expect(
      formatBrowseFilterLabel({ column: "Size", op: "=", value: "1024" }, columns, columnTypes),
    ).toBe("Size is 1024");
  });

  it("unescapes metacharacters in contains filter labels", () => {
    expect(
      formatBrowseFilterLabel({ column: "Name", op: "LIKE", value: "%100\\%%" }, columns, columnTypes),
    ).toBe("Name contains 100%");
  });
});
