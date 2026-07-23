import { describe, expect, it } from "vitest"

import {
  bucketMetrics,
  findDef,
  formatValue,
  metricStatus,
  METRIC_GROUPS,
  GROUP_HEADLINE_KEYS,
  MEAN_JUDGE_KEYS,
} from "./eval-run-overview.catalog"

describe("eval-run-overview.catalog · formatValue", () => {
  it("[tag:eval][tag:catalog] rounds percents", () => {
    expect(formatValue(90.6, "percent")).toBe("91%")
  })

  it("[tag:eval][tag:catalog] renders ms below 1000 as ms and above as seconds", () => {
    expect(formatValue(850, "ms")).toBe("850 ms")
    expect(formatValue(1700, "ms")).toBe("1.7 s")
  })

  it("[tag:eval][tag:catalog] formats tokens with locale separators", () => {
    expect(formatValue(31250, "tokens")).toBe((31250).toLocaleString())
  })

  it("[tag:eval][tag:catalog] formats currency with two decimals", () => {
    expect(formatValue(7.4, "currency")).toBe("$7.40")
  })

  it("[tag:eval][tag:catalog] falls back to String for raw unit", () => {
    expect(formatValue(42, "raw")).toBe("42")
  })
})

describe("eval-run-overview.catalog · findDef", () => {
  it("[tag:eval][tag:catalog] matches a known key case-insensitively", () => {
    expect(findDef("Helpfulness")?.group).toBe("ai-judge")
    expect(findDef("  groundedness ")?.group).toBe("rag-quality")
    expect(findDef("ROUGE-L")?.group).toBe("correctness")
  })

  it("[tag:eval][tag:catalog] returns undefined for an unknown key", () => {
    expect(findDef("totally-unknown")).toBeUndefined()
  })
})

describe("eval-run-overview.catalog · metricStatus", () => {
  it("[tag:eval][tag:catalog] passes percent >= 70 and warns below", () => {
    expect(metricStatus(70, "percent", true)).toBe("pass")
    expect(metricStatus(69, "percent", true)).toBe("warn")
  })

  it("[tag:eval][tag:catalog] is neutral for non-percent or non-higherIsBetter", () => {
    expect(metricStatus(2100, "ms", false)).toBe("neutral")
    expect(metricStatus(90, "percent", false)).toBe("neutral")
  })
})

describe("eval-run-overview.catalog · bucketMetrics", () => {
  it("[tag:eval][tag:catalog] buckets known metrics into their groups", () => {
    const { groups, leftovers } = bucketMetrics({
      Helpfulness: 93,
      Groundedness: 90,
      "Token F1": 71,
      "P95 latency": 2100,
      "Total tokens": 31250,
    })

    expect(groups.get("ai-judge")?.[0].label).toBe("Helpfulness")
    expect(groups.get("rag-quality")?.[0].label).toBe("Groundedness")
    expect(groups.get("correctness")?.[0].label).toBe("Token F1")
    expect(groups.get("performance")?.[0].label).toBe("P95 latency")
    expect(groups.get("token-usage")?.[0].label).toBe("Total tokens")
    expect(leftovers).toHaveLength(0)
  })

  it("[tag:eval][tag:catalog] collects unknown keys as leftovers with raw unit", () => {
    const { leftovers } = bucketMetrics({ "Mystery metric": 5 })

    expect(leftovers).toHaveLength(1)
    expect(leftovers[0]).toMatchObject({ label: "Mystery metric", unit: "raw" })
  })
})

describe("eval-run-overview.catalog · static config", () => {
  it("[tag:eval][tag:catalog] exposes five metric groups and headline keys", () => {
    expect(METRIC_GROUPS).toHaveLength(5)
    expect(GROUP_HEADLINE_KEYS["rag-quality"]).toContain("groundedness")
    expect(MEAN_JUDGE_KEYS.has("mean ai judge score")).toBe(true)
  })
})
