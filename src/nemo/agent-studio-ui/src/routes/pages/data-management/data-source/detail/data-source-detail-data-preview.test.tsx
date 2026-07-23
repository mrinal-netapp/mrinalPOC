import { screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { renderWithProviders, userEvent } from "@test/render";
import type { DataSourceDetail } from "@/api/data-source.types";

vi.mock("@/components/data-source/preview/browse-filter-builder", () => ({
  BrowseFilterBuilder: ({
    columns,
    onApply,
    onClear,
  }: {
    columns: string[];
    onApply: (filters: Array<{ column: string; op: string; value?: string }>) => void;
    onClear: () => void;
  }) => (
    <div data-testid="browse-filter-builder" data-columns={columns.join(",")}>
      <button
        type="button"
        onClick={() => onApply([{ column: "Name", op: "LIKE", value: "%file-a%" }])}
      >
        apply-filter
      </button>
      <button type="button" onClick={onClear}>clear-filters</button>
    </div>
  ),
}));

vi.mock("@/components/data-source/volume-browser/VolumeBrowserDialog", () => ({
  VolumeBrowser: ({
    volumeId,
    clientFilters,
  }: {
    volumeId: string;
    clientFilters?: Array<{ column: string }>;
  }) => (
    <div
      data-testid="volume-browser"
      data-id={volumeId}
      data-filter-count={String(clientFilters?.length ?? 0)}
    />
  ),
}));

vi.mock("@/components/data-source/connector-browser/connector-browser-dialog", () => ({
  ConnectorBrowser: ({
    connectorId,
    clientFilters,
  }: {
    connectorId: string;
    clientFilters?: Array<{ column: string }>;
  }) => (
    <div
      data-testid="connector-browser"
      data-id={connectorId}
      data-filter-count={String(clientFilters?.length ?? 0)}
    />
  ),
}));

import { DataSourceDetailDataPreview } from "./data-source-detail-data-preview";

const VOLUME_DETAIL: DataSourceDetail = {
  dsrc_id: "vol-1",
  name: "test-vol",
  source_type: "NFS",
  status: "Healthy",
  scan_status: "Completed",
  deprecated: false,
  labels: [],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  description: null,
  connection: {
    server: "nfs.example.com",
    export_path: "/data",
    folder_boundary: null,
    auth_method: "none",
    username: "",
  },
  modified_by: "admin",
  scan: null,
  scanned_data_count: null,
  associated_datasets: [],
  associated_datasets_count: 0,
  last_validated_at: null,
  last_validation_error: null,
};

const CONNECTOR_DETAIL: DataSourceDetail = {
  ...VOLUME_DETAIL,
  dsrc_id: "cn-1",
  name: "test-s3",
  source_type: null,
  category: "Object Store",
  provider: "s3",
  connector_scope: "resource",
  connector_config: { provider: "s3", scope: "resource", connector_type: "objectstore", bucket: "b" },
};

function renderPreview(data: DataSourceDetail) {
  return renderWithProviders(
    <DataSourceDetailDataPreview data={data} projectId="proj-1" />,
  );
}

describe("DataSourceDetailDataPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("[tag:data-preview] renders volume browser for volume sources", () => {
    renderPreview(VOLUME_DETAIL);

    expect(screen.getByText("Advanced search and filtering")).toBeInTheDocument();
    expect(screen.getByText("None selected")).toBeInTheDocument();
    expect(screen.getByTestId("volume-browser")).toHaveAttribute("data-id", "vol-1");
    expect(screen.queryByTestId("connector-browser")).not.toBeInTheDocument();
    expect(screen.getByTestId("browse-filter-builder")).not.toBeVisible();
  });

  it("[tag:data-preview] renders connector browser for connector sources", () => {
    renderPreview(CONNECTOR_DETAIL);

    expect(screen.getByTestId("connector-browser")).toHaveAttribute("data-id", "cn-1");
    expect(screen.queryByTestId("volume-browser")).not.toBeInTheDocument();
    expect(screen.getByTestId("browse-filter-builder")).not.toBeVisible();
  });

  it("[tag:data-preview] advanced filter toggle associates button with panel via aria-controls", () => {
    renderPreview(VOLUME_DETAIL);

    const toggle = screen.getByRole("button", { name: /Advanced search and filtering/i });
    expect(toggle).toHaveAttribute("aria-controls", "ds-preview-advanced-vol-1");
    expect(document.getElementById("ds-preview-advanced-vol-1")).toBeInTheDocument();
  });

  it("[tag:data-preview] expanding advanced filter reveals BrowseFilterBuilder", async () => {
    const user = userEvent.setup();
    renderPreview(VOLUME_DETAIL);

    await user.click(screen.getByRole("button", { name: /Advanced search and filtering/i }));

    expect(screen.getByTestId("browse-filter-builder")).toBeVisible();
    expect(screen.getByTestId("browse-filter-builder")).toHaveAttribute(
      "data-columns",
      "Name,Type,Size,Last modified",
    );
  });

  it("[tag:data-preview] keeps BrowseFilterBuilder mounted when advanced section is collapsed", async () => {
    const user = userEvent.setup();
    renderPreview(VOLUME_DETAIL);

    await user.click(screen.getByRole("button", { name: /Advanced search and filtering/i }));
    expect(screen.getByTestId("browse-filter-builder")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Advanced search and filtering/i }));
    expect(screen.getByTestId("browse-filter-builder")).not.toBeVisible();
    expect(screen.getByTestId("browse-filter-builder")).toBeInTheDocument();
  });

  it("[tag:data-preview][tag:filters] applying filters passes them to the browser", async () => {
    const user = userEvent.setup();
    renderPreview(VOLUME_DETAIL);

    await user.click(screen.getByRole("button", { name: /Advanced search and filtering/i }));
    await user.click(screen.getByRole("button", { name: "apply-filter" }));

    expect(screen.getByTestId("volume-browser")).toHaveAttribute("data-filter-count", "1");
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove filter: Name contains file-a" })).toBeInTheDocument();
  });

  it("[tag:data-preview][tag:filters] clearing filters resets browser filter count", async () => {
    const user = userEvent.setup();
    renderPreview(VOLUME_DETAIL);

    await user.click(screen.getByRole("button", { name: /Advanced search and filtering/i }));
    await user.click(screen.getByRole("button", { name: "apply-filter" }));
    await user.click(screen.getByRole("button", { name: "clear-filters" }));

    expect(screen.getByTestId("volume-browser")).toHaveAttribute("data-filter-count", "0");
    expect(screen.getByText("None selected")).toBeInTheDocument();
  });
});
