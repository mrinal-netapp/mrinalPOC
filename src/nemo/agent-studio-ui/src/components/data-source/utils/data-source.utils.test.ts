import { describe, it, expect } from "vitest"
import {
  IconCircleCheck,
  IconCircleX,
  IconAlertTriangle,
  IconCircleMinus,
} from "@tabler/icons-react"

import {
  STATUS_ICON_MAP,
  SCAN_STATUS_ICON_MAP,
  DATASET_STATUS_ICON_MAP,
  ACTIVITY_STATUS_ICON_MAP,
  DEPRECATED_VISUAL,
  getScanStatusLabel,
  getScanDepthDisplay,
  formatDateShort,
  formatDateTimeFull,
  formatBytes,
  formatNumber,
} from "./data-source.utils"

// ---------------------------------------------------------------------------
// Section 2 — data-source.utils.ts
// ---------------------------------------------------------------------------

describe("data-source.utils", () => {
  // -- STATUS_ICON_MAP --

  // 2.1
  describe("STATUS_ICON_MAP", () => {
    it("[tag:ds-utils][tag:status-visual] Initializing uses spinner type", () => {
      expect(STATUS_ICON_MAP.Initializing.type).toBe("spinner")
      expect(STATUS_ICON_MAP.Initializing.color).toBe("var(--notification-information)")
    })

    it("[tag:ds-utils][tag:status-visual] Healthy maps to check icon with success color", () => {
      expect(STATUS_ICON_MAP.Healthy.type).toBe("icon")
      expect(STATUS_ICON_MAP.Healthy.Icon).toBe(IconCircleCheck)
      expect(STATUS_ICON_MAP.Healthy.color).toBe("var(--notification-success)")
    })

    it("[tag:ds-utils][tag:status-visual] Unhealthy maps to X icon with error color", () => {
      expect(STATUS_ICON_MAP.Unhealthy.type).toBe("icon")
      expect(STATUS_ICON_MAP.Unhealthy.Icon).toBe(IconCircleX)
      expect(STATUS_ICON_MAP.Unhealthy.color).toBe("var(--notification-error)")
    })

    it("[tag:ds-utils][tag:status-visual] Failed maps to X icon with error color", () => {
      expect(STATUS_ICON_MAP.Failed.type).toBe("icon")
      expect(STATUS_ICON_MAP.Failed.Icon).toBe(IconCircleX)
      expect(STATUS_ICON_MAP.Failed.color).toBe("var(--notification-error)")
    })
  })

  // 2.2
  describe("DEPRECATED_VISUAL", () => {
    it("[tag:ds-utils][tag:status-visual] has icon type, IconCircleMinus, and disabled color", () => {
      expect(DEPRECATED_VISUAL.type).toBe("icon")
      expect(DEPRECATED_VISUAL.Icon).toBe(IconCircleMinus)
      expect(DEPRECATED_VISUAL.color).toBe("var(--text-disabled)")
    })
  })

  // 2.3
  describe("SCAN_STATUS_ICON_MAP", () => {
    it("[tag:ds-utils][tag:scan-status-visual] Completed maps to check icon with success color", () => {
      expect(SCAN_STATUS_ICON_MAP.Completed.type).toBe("icon")
      expect(SCAN_STATUS_ICON_MAP.Completed.Icon).toBe(IconCircleCheck)
      expect(SCAN_STATUS_ICON_MAP.Completed.color).toBe("var(--notification-success)")
    })

    it("[tag:ds-utils][tag:scan-status-visual] Unscanned maps to warning icon", () => {
      expect(SCAN_STATUS_ICON_MAP.Unscanned.type).toBe("icon")
      expect(SCAN_STATUS_ICON_MAP.Unscanned.Icon).toBe(IconAlertTriangle)
      expect(SCAN_STATUS_ICON_MAP.Unscanned.color).toBe("var(--notification-warning)")
    })

    it("[tag:ds-utils][tag:scan-status-visual] Scanning uses spinner type", () => {
      expect(SCAN_STATUS_ICON_MAP.Scanning.type).toBe("spinner")
      expect(SCAN_STATUS_ICON_MAP.Scanning.color).toBe("var(--notification-information)")
    })

    it("[tag:ds-utils][tag:scan-status-visual] Failed maps to X icon with error color", () => {
      expect(SCAN_STATUS_ICON_MAP.Failed.type).toBe("icon")
      expect(SCAN_STATUS_ICON_MAP.Failed.Icon).toBe(IconCircleX)
      expect(SCAN_STATUS_ICON_MAP.Failed.color).toBe("var(--notification-error)")
    })
  })

  // 2.4
  describe("getScanStatusLabel", () => {
    it("[tag:ds-utils][tag:scan-status-label] Completed returns 'Scanned'", () => {
      expect(getScanStatusLabel("Completed")).toBe("Scanned")
    })

    it("[tag:ds-utils][tag:scan-status-label] Unscanned returns 'Unscanned'", () => {
      expect(getScanStatusLabel("Unscanned")).toBe("Unscanned")
    })

    it("[tag:ds-utils][tag:scan-status-label] Scanning returns 'Scanning'", () => {
      expect(getScanStatusLabel("Scanning")).toBe("Scanning")
    })

    it("[tag:ds-utils][tag:scan-status-label] Failed returns 'Failed'", () => {
      expect(getScanStatusLabel("Failed")).toBe("Failed")
    })
  })

  // 2.5
  describe("formatDateShort", () => {
    it("[tag:ds-utils][tag:format-date] formats ISO string to 'Mon D, YYYY' pattern", () => {
      // Use a fixed date to avoid locale/timezone flakiness
      const result = formatDateShort("2024-03-15T10:00:00Z")
      expect(result).toMatch(/Mar 1[45], 2024/)
    })
  })

  // 2.6
  describe("formatDateTimeFull", () => {
    it("[tag:ds-utils][tag:format-date] formats ISO string including time components", () => {
      const result = formatDateTimeFull("2024-03-15T14:30:00Z")
      // Should contain year, month abbreviation, AM/PM
      expect(result).toMatch(/2024/)
      expect(result).toMatch(/Mar/)
      expect(result).toMatch(/[AP]M/)
    })
  })

  // 2.7 & 2.8 & 2.9
  describe("formatBytes", () => {
    it("[tag:ds-utils][tag:format-bytes] null returns '-'", () => {
      expect(formatBytes(null)).toBe("-")
    })

    it("[tag:ds-utils][tag:format-bytes] undefined returns '-'", () => {
      expect(formatBytes(undefined)).toBe("-")
    })

    it("[tag:ds-utils][tag:format-bytes] 0 returns '0 B'", () => {
      expect(formatBytes(0)).toBe("0 B")
    })

    it("[tag:ds-utils][tag:format-bytes] bytes scale correctly to KB", () => {
      expect(formatBytes(1024)).toBe("1 KB")
    })

    it("[tag:ds-utils][tag:format-bytes] bytes scale correctly to MB", () => {
      expect(formatBytes(1024 * 1024)).toBe("1 MB")
    })

    it("[tag:ds-utils][tag:format-bytes] bytes scale correctly to GB", () => {
      expect(formatBytes(1024 * 1024 * 1024)).toBe("1 GB")
    })

    it("[tag:ds-utils][tag:format-bytes] fractional values use one decimal place", () => {
      expect(formatBytes(1536)).toBe("1.5 KB")
    })
  })

  // 2.10 & 2.11
  describe("formatNumber", () => {
    it("[tag:ds-utils][tag:format-number] null returns '-'", () => {
      expect(formatNumber(null)).toBe("-")
    })

    it("[tag:ds-utils][tag:format-number] undefined returns '-'", () => {
      expect(formatNumber(undefined)).toBe("-")
    })

    it("[tag:ds-utils][tag:format-number] large number formats with locale separators", () => {
      expect(formatNumber(1000000)).toBe("1,000,000")
    })
  })

  // 2.12–2.15
  describe("getScanDepthDisplay", () => {
    it("[tag:ds-utils][tag:scan-depth] undefined depth returns '-'", () => {
      expect(getScanDepthDisplay(undefined, null)).toBe("-")
    })

    it("[tag:ds-utils][tag:scan-depth] standard depth returns matching label", () => {
      expect(getScanDepthDisplay("top_2_levels", null)).toBe("Top 2 folder levels")
      expect(getScanDepthDisplay("all_levels", null)).toBe("All folder levels")
    })

    it("[tag:ds-utils][tag:scan-depth] 'custom' with non-null customDepth returns label with count", () => {
      expect(getScanDepthDisplay("custom", 5)).toBe("Custom (5 levels)")
    })

    it("[tag:ds-utils][tag:scan-depth] 'custom' with null customDepth returns base 'Custom' label", () => {
      expect(getScanDepthDisplay("custom", null)).toBe("Custom")
    })

  })

  // -- DATASET_STATUS_ICON_MAP (spot-check for complete coverage) --
  describe("DATASET_STATUS_ICON_MAP", () => {
    it("[tag:ds-utils][tag:status-visual] Draft uses CircleMinus with disabled color", () => {
      expect(DATASET_STATUS_ICON_MAP.Draft.Icon).toBe(IconCircleMinus)
      expect(DATASET_STATUS_ICON_MAP.Draft.color).toBe("var(--text-disabled)")
    })

    it("[tag:ds-utils][tag:status-visual] Healthy and Ready both use check icon", () => {
      expect(DATASET_STATUS_ICON_MAP.Healthy.Icon).toBe(IconCircleCheck)
      expect(DATASET_STATUS_ICON_MAP.Ready.Icon).toBe(IconCircleCheck)
    })

    it("[tag:ds-utils][tag:status-visual] Unhealthy and Failed both use X icon", () => {
      expect(DATASET_STATUS_ICON_MAP.Unhealthy.Icon).toBe(IconCircleX)
      expect(DATASET_STATUS_ICON_MAP.Failed.Icon).toBe(IconCircleX)
    })
  })

  // -- ACTIVITY_STATUS_ICON_MAP --
  describe("ACTIVITY_STATUS_ICON_MAP", () => {
    it("[tag:ds-utils][tag:status-visual] 'In Progress' uses spinner", () => {
      expect(ACTIVITY_STATUS_ICON_MAP["In Progress"].type).toBe("spinner")
    })

    it("[tag:ds-utils][tag:status-visual] Success uses check icon", () => {
      expect(ACTIVITY_STATUS_ICON_MAP.Success.Icon).toBe(IconCircleCheck)
    })

    it("[tag:ds-utils][tag:status-visual] Warning uses triangle icon", () => {
      expect(ACTIVITY_STATUS_ICON_MAP.Warning.Icon).toBe(IconAlertTriangle)
    })
  })
})
