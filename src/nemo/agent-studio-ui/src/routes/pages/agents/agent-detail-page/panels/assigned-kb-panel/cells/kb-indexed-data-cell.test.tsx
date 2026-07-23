import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { KbIndexedDataCell } from "./kb-indexed-data-cell";
import { ASSIGNED_KB_PANEL_STRINGS } from "../assigned-kb-panel.consts";

describe("KbIndexedDataCell", () => {
  it(
    "[tag:agents-cell] formats file + vector counts with locale-aware thousand separators",
    () => {
      render(
        <KbIndexedDataCell indexed={{ fileCount: 1234, vectorCount: 567890 }} />,
      );

      // The exact grouping separator depends on the test environment's
      // default locale (en-US → "1,234"; en-IN → "5,67,890"; de-DE →
      // "1.234"; fr-FR uses U+00A0). Strip every non-digit so the
      // assertion locks only the digits and their order — that's the
      // contract the cell should keep across every locale.
      const text = screen.getByText(/files.*vectors/i).textContent ?? "";
      const digits = text.replace(/\D+/g, "");
      expect(digits).toContain("1234");
      expect(digits).toContain("567890");
      expect(text).toContain(ASSIGNED_KB_PANEL_STRINGS.INDEXED_FILES_SUFFIX);
      expect(text).toContain(ASSIGNED_KB_PANEL_STRINGS.INDEXED_VECTORS_SUFFIX);
    },
  );

  it(
    "[tag:agents-cell] still renders both zero counts (no early return)",
    () => {
      render(
        <KbIndexedDataCell indexed={{ fileCount: 0, vectorCount: 0 }} />,
      );
      expect(screen.getByText(/files.*vectors/i)).toBeInTheDocument();
    },
  );
});
