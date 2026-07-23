import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@test/render";
import { RunDetailsStatisticsTab } from "./run-details-statistics-tab";

describe("RunDetailsStatisticsTab", () => {
  it("[tag:agents] shows empty prompt when statistics are empty", () => {
    renderWithProviders(
      <RunDetailsStatisticsTab statistics={{ sections: [], isEmpty: true }} />,
    );

    expect(
      screen.getByText("Send a message in Chat to see statistics for the latest run."),
    ).toBeInTheDocument();
  });

  it("[tag:agents] renders statistics sections and rows", () => {
    renderWithProviders(
      <RunDetailsStatisticsTab
        statistics={{
          isEmpty: false,
          sections: [
            {
              title: "Timing",
              rows: [
                { label: "Latency", value: "120 ms" },
                { label: "Generation time", value: "80 ms" },
              ],
            },
            {
              title: "Tokens",
              rows: [{ label: "Total tokens", value: "1,200" }],
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Timing" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tokens" })).toBeInTheDocument();
    expect(screen.getByText("Latency")).toBeInTheDocument();
    expect(screen.getByText("120 ms")).toBeInTheDocument();
    expect(screen.getByText("Total tokens")).toBeInTheDocument();
    expect(screen.getByText("1,200")).toBeInTheDocument();
  });
});
