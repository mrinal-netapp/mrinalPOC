import { describe, expect, it } from "vitest";

import { classifyDuckDBType } from "./duckdb-types";

describe("classifyDuckDBType", () => {
  it("classifies integer family types", () => {
    for (const t of ["INTEGER", "BIGINT", "SMALLINT", "TINYINT", "HUGEINT", "UBIGINT", "UINTEGER", "USMALLINT", "UTINYINT"]) {
      expect(classifyDuckDBType(t)).toBe("integer");
    }
  });

  it("classifies float family types", () => {
    for (const t of ["DOUBLE", "FLOAT", "REAL", "DECIMAL(10,2)", "NUMERIC"]) {
      expect(classifyDuckDBType(t)).toBe("float");
    }
  });

  it("classifies string family types", () => {
    for (const t of ["VARCHAR", "TEXT", "CHAR", "BLOB", "UUID", "ENUM"]) {
      expect(classifyDuckDBType(t)).toBe("string");
    }
  });

  it("classifies temporal family types", () => {
    for (const t of ["TIMESTAMP", "DATE", "TIME", "INTERVAL"]) {
      expect(classifyDuckDBType(t)).toBe("temporal");
    }
  });

  it("classifies boolean and everything else", () => {
    expect(classifyDuckDBType("BOOLEAN")).toBe("boolean");
    expect(classifyDuckDBType("STRUCT")).toBe("other");
    expect(classifyDuckDBType("")).toBe("other");
  });

  it("is case-insensitive", () => {
    expect(classifyDuckDBType("integer")).toBe("integer");
    expect(classifyDuckDBType("varchar")).toBe("string");
  });
});
