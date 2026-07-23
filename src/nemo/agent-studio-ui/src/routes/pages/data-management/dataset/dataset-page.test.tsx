import { screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { renderWithProviders } from "@test/render";
import { DATASET_STRINGS } from "../data-management.consts";
import { DatasetPage } from "./dataset-page";

vi.mock("./list/dataset-list-content", () => ({
  DatasetListContent: () => <div data-testid="dataset-list-mount" />,
}));

describe("DatasetPage", () => {
  it("[tag:dataset-page] renders page title and subtitle from DATASET_STRINGS", () => {
    renderWithProviders(<DatasetPage />);

    expect(screen.getByText(DATASET_STRINGS.PAGE_TITLE)).toBeInTheDocument();
    expect(screen.getByText(DATASET_STRINGS.PAGE_SUBTITLE)).toBeInTheDocument();
  });

  it("[tag:dataset-page] mounts DatasetListContent inside the page", () => {
    renderWithProviders(<DatasetPage />);

    expect(screen.getByTestId("dataset-list-mount")).toBeInTheDocument();
  });
});
