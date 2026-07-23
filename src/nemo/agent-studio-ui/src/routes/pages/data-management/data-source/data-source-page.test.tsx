import { screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { renderWithProviders } from "@test/render";
import { DATA_SOURCE_STRINGS } from "../data-management.consts";
import { DataSourcePage } from "./data-source-page";

// The inner list pulls in RTK Query + table machinery. Stub it so this test
// stays focused on the container contract (header + list mount-point only).
vi.mock("./list/data-source-list", () => ({
  DataSourceListContent: () => <div data-testid="data-source-list-mount" />,
}));

describe("DataSourcePage", () => {
  it("[tag:data-source-page] renders page title and subtitle from DATA_SOURCE_STRINGS", () => {
    renderWithProviders(<DataSourcePage />);

    expect(screen.getByText(DATA_SOURCE_STRINGS.PAGE_TITLE)).toBeInTheDocument();
    expect(screen.getByText(DATA_SOURCE_STRINGS.PAGE_SUBTITLE)).toBeInTheDocument();
  });

  it("[tag:data-source-page] mounts DataSourceListContent inside the page", () => {
    renderWithProviders(<DataSourcePage />);

    expect(screen.getByTestId("data-source-list-mount")).toBeInTheDocument();
  });
});
