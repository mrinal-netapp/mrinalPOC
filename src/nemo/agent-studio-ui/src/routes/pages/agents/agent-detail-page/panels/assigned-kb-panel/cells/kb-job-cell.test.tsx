import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { KbJobCell } from "./kb-job-cell";
import {
  ASSIGNED_KB_PANEL_STRINGS,
  KB_JOB_SEGMENT_COUNT,
} from "../assigned-kb-panel.consts";

describe("KbJobCell", () => {
  it(
    "[tag:agents-cell] renders the Ready label and a 100%-full bar when state is Ready",
    () => {
      const { container } = render(
        <KbJobCell job={{ state: "Ready", progress: 1 }} />,
      );

      const bar = screen.getByRole("progressbar", {
        name: ASSIGNED_KB_PANEL_STRINGS.JOB_READY,
      });
      expect(bar).toHaveAttribute("aria-valuenow", "1");

      const filled = container.querySelectorAll(
        ".kb-job-cell__segment.kb-job-cell__segment--ready",
      );
      expect(filled.length).toBe(KB_JOB_SEGMENT_COUNT);
    },
  );

  it(
    "[tag:agents-cell] renders the Processing label and a partially-filled bar",
    () => {
      const { container } = render(
        <KbJobCell job={{ state: "Processing", progress: 0.5 }} />,
      );

      expect(
        screen.getByRole("progressbar", {
          name: ASSIGNED_KB_PANEL_STRINGS.JOB_PROCESSING,
        }),
      ).toHaveAttribute("aria-valuenow", "0.5");

      // ceil(0.5 * 4) = 2 segments lit.
      const filled = container.querySelectorAll(
        ".kb-job-cell__segment.kb-job-cell__segment--processing",
      );
      expect(filled.length).toBe(2);
    },
  );

  it(
    "[tag:agents-cell] clamps an out-of-range progress value into [0, 1]",
    () => {
      const { container, rerender } = render(
        <KbJobCell job={{ state: "Processing", progress: 5 }} />,
      );
      expect(screen.getByRole("progressbar")).toHaveAttribute(
        "aria-valuenow",
        "1",
      );
      expect(
        container.querySelectorAll(".kb-job-cell__segment--processing").length,
      ).toBe(KB_JOB_SEGMENT_COUNT);

      rerender(<KbJobCell job={{ state: "Processing", progress: -2 }} />);
      expect(screen.getByRole("progressbar")).toHaveAttribute(
        "aria-valuenow",
        "0",
      );
      expect(
        container.querySelectorAll(".kb-job-cell__segment--processing").length,
      ).toBe(0);
    },
  );
});
