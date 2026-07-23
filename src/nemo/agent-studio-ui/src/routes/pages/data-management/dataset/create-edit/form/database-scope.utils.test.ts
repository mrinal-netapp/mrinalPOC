import { describe, it, expect, vi } from "vitest";

import {
  buildSqlFromDatabaseTableResource,
  findFirstDatabaseTableResource,
  mergeResourceSelectorEntries,
  mergeResourceSelectorEntriesForCategory,
  parseDatabaseTableResource,
  pickSingleFolderPath,
  populateSchemaQueryFromDatabaseTables,
} from "./database-scope.utils";

describe("database-scope.utils", () => {
  it("parseDatabaseTableResource returns null for non-table entries", () => {
    expect(parseDatabaseTableResource({ bucket: "b1" })).toBeNull();
  });

  it("buildSqlFromDatabaseTableResource uses double quotes for PostgreSQL", () => {
    expect(
      buildSqlFromDatabaseTableResource(
        { database: "sakila", schema: "sakila", table: "customer" },
        "postgresql",
      ),
    ).toBe('-- Database: sakila\nSELECT * FROM "sakila"."customer"');
    expect(
      buildSqlFromDatabaseTableResource({ schema: "sakila", table: "customer" }),
    ).toBe('SELECT * FROM "sakila"."customer"');
  });

  it("buildSqlFromDatabaseTableResource uses backticks for MySQL", () => {
    expect(
      buildSqlFromDatabaseTableResource(
        { database: "sakila", schema: "sakila", table: "customer" },
        "mysql",
      ),
    ).toBe("-- Database: sakila\nSELECT * FROM `sakila`.`customer`");
  });

  it("mergeResourceSelectorEntries dedupes by JSON key", () => {
    const a = { schema: "s", table: "t" };
    expect(mergeResourceSelectorEntries([a], [a, { schema: "s", table: "u" }])).toEqual([
      a,
      { schema: "s", table: "u" },
    ]);
  });

  it("mergeResourceSelectorEntriesForCategory replaces prior table for Database", () => {
    const sbtest1 = { database: "sysbench", schema: "sysbench", table: "sbtest1" };
    const sbtest2 = { database: "sysbench", schema: "sysbench", table: "sbtest2" };
    expect(
      mergeResourceSelectorEntriesForCategory([sbtest1], [sbtest2]),
    ).toEqual([sbtest2]);
  });

  it("mergeResourceSelectorEntriesForCategory replaces prior entry for single-select Object Store", () => {
    const a = { bucket: "b1", prefix: "p1/" };
    const b = { bucket: "b1", prefix: "p2/" };
    expect(
      mergeResourceSelectorEntriesForCategory([a], [b], "s3"),
    ).toEqual([b]);
  });

  it("mergeResourceSelectorEntriesForCategory merges for multi-select ONTAP", () => {
    const a = { category: "volume_metrics", svm_uuid: "svm-1" };
    const b = { category: "volume_metrics", svm_uuid: "svm-2" };
    expect(
      mergeResourceSelectorEntriesForCategory([a], [b], "ontap"),
    ).toEqual([a, b]);
  });

  it("mergeResourceSelectorEntriesForCategory merges multiple metric categories for GCP", () => {
    const volume = { category: "volume_metrics" };
    const pool = { category: "pool_metrics" };
    const tier = { category: "volume_tier_metrics" };
    expect(
      mergeResourceSelectorEntriesForCategory([], [volume, pool, tier], "gcp"),
    ).toEqual([volume, pool, tier]);
    expect(
      mergeResourceSelectorEntriesForCategory([volume], [pool, tier], "gcp"),
    ).toEqual([volume, pool, tier]);
  });

  it("mergeResourceSelectorEntriesForCategory merges multiple metric categories for Azure ANF", () => {
    const volume = { category: "volume_metrics" };
    const pool = { category: "pool_metrics" };
    expect(
      mergeResourceSelectorEntriesForCategory([volume], [pool], "azure_cloud"),
    ).toEqual([volume, pool]);
  });

  it("mergeResourceSelectorEntriesForCategory replaces scope when switching between metric and non-metric", () => {
    const bucket = { bucket: "b1", prefix: "p1/" };
    const metric = { category: "volume_metrics" };
    expect(
      mergeResourceSelectorEntriesForCategory([bucket], [metric], "gcp"),
    ).toEqual([metric]);
    expect(
      mergeResourceSelectorEntriesForCategory([metric], [bucket], "gcp"),
    ).toEqual([bucket]);
  });

  it("mergeResourceSelectorEntriesForCategory rejects a single batch mixing metrics with other scope shapes", () => {
    const bucket = { bucket: "b1", prefix: "p1/" };
    const metric = { category: "volume_metrics" };
    expect(
      mergeResourceSelectorEntriesForCategory([bucket], [bucket, metric], "gcp"),
    ).toEqual([bucket]);
    expect(
      mergeResourceSelectorEntriesForCategory([], [bucket, metric], "gcp"),
    ).toEqual([]);
  });

  it("pickSingleFolderPath keeps the latest non-empty path", () => {
    expect(pickSingleFolderPath(["/a", "/b"])).toBe("/b");
    expect(pickSingleFolderPath(["  ", "/data"])).toBe("/data");
    expect(pickSingleFolderPath([])).toBeNull();
  });

  it("findFirstDatabaseTableResource returns the first table entry", () => {
    expect(
      findFirstDatabaseTableResource([
        { bucket: "b" },
        { schema: "s", table: "t" },
      ]),
    ).toEqual({ schema: "s", table: "t" });
  });

  it("populateSchemaQueryFromDatabaseTables sets schema_query on the form", () => {
    const setFieldValue = vi.fn();
    const form = { setFieldValue };

    populateSchemaQueryFromDatabaseTables(
      form as never,
      [{ database: "sakila", schema: "sakila", table: "customer" }],
      "mysql",
    );

    expect(setFieldValue).toHaveBeenCalledWith(
      "schema_query",
      "-- Database: sakila\nSELECT * FROM `sakila`.`customer`",
    );
  });
});
