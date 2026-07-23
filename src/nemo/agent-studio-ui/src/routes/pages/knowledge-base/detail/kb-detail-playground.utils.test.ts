import { describe, it, expect } from "vitest";

import { generateId, getRelevanceLabel } from "./kb-detail-playground.utils";

describe("kb-detail-playground.utils", () => {
  describe("generateId", () => {
    const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    it("[tag:utils] returns a valid UUID v4 format", () => {
      const id = generateId();

      expect(id).toMatch(UUID_V4_REGEX);
    });

    it("[tag:utils] sets correct version bit (4)", () => {
      const id = generateId();
      const versionChar = id.charAt(14);

      expect(versionChar).toBe("4");
    });

    it("[tag:utils] sets correct variant bits (8, 9, a, or b)", () => {
      const id = generateId();
      const variantChar = id.charAt(19);

      expect(["8", "9", "a", "b"]).toContain(variantChar.toLowerCase());
    });

    it("[tag:utils] generates unique IDs on successive calls", () => {
      const ids = new Set<string>();
      const count = 100;

      for (let i = 0; i < count; i++) {
        ids.add(generateId());
      }

      expect(ids.size).toBe(count);
    });
  });

  describe("getRelevanceLabel", () => {
    it("[tag:utils] returns highly relevant for score >= 0.90", () => {
      const result = getRelevanceLabel(0.95);

      expect(result.label).toBe("95% (Highly relevant)");
      expect(result.color).toBe("green");
      expect(result.status).toBe("success");
    });

    it("[tag:utils] returns relevant for score >= 0.80 and < 0.90", () => {
      const result = getRelevanceLabel(0.85);

      expect(result.label).toBe("85% (Relevant)");
      expect(result.color).toBe("blue");
      expect(result.status).toBe("info");
    });

    it("[tag:utils] returns somewhat relevant for score < 0.80", () => {
      const result = getRelevanceLabel(0.65);

      expect(result.label).toBe("65% (Somewhat relevant)");
      expect(result.color).toBe("orange");
      expect(result.status).toBe("warning");
    });

    it("[tag:utils] rounds score to nearest integer percentage", () => {
      const result = getRelevanceLabel(0.876);

      expect(result.label).toBe("88% (Relevant)");
    });

    it("[tag:utils] handles boundary case at exactly 0.90", () => {
      const result = getRelevanceLabel(0.90);

      expect(result.label).toBe("90% (Highly relevant)");
      expect(result.color).toBe("green");
    });

    it("[tag:utils] handles boundary case at exactly 0.80", () => {
      const result = getRelevanceLabel(0.80);

      expect(result.label).toBe("80% (Relevant)");
      expect(result.color).toBe("blue");
    });
  });
});
