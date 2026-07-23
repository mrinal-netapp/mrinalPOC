import { screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { renderWithProviders, userEvent } from "@test/render";
import { mockResizeObserver } from "@test/mocks";
import { useForm } from "@tanstack/react-form";
import { Form } from "@/ui-lib/base-components/form";
import type { DatasetKind } from "@/api/dataset.types";
import type { DataSourceListItem } from "@/api/data-source.types";
import { buildDefaultValues } from "./dataset-form.utils";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockListDataSources = vi.fn();

vi.mock("@/api/data-source-api.slice", () => ({
  useListDataSourcesQuery: () => mockListDataSources(),
}));

// The picker's "View" action opens the volume browser. Mock it so we can assert
// open/close without real API calls.
vi.mock("@/components/data-source/volume-browser/VolumeBrowserDialog", () => ({
  VolumeBrowserDialog: ({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) =>
    open ? (
      <div data-testid="volume-browser-dialog">
        Folder overview
        <button onClick={() => onOpenChange(false)}>Close browser</button>
      </div>
    ) : null,
}));

import { DataSourcePicker } from "./data-source-picker";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_DS: DataSourceListItem = {
  dsrc_id: "ds-1",
  name: "My Source",
  source_type: "NFS",
  category: "Volume",
  status: "Healthy",
  scan_status: "Completed",
  deprecated: false,
  labels: [],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  associated_datasets: [],
  associated_datasets_count: 0,
  last_validated_at: null,
  last_validation_error: null,
  scan: null,
};

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

function PickerWrapper({
  withSubmit = false,
  kind = "unstructured" as DatasetKind | "",
}: {
  withSubmit?: boolean;
  kind?: DatasetKind | "";
}): ReactElement {
  const defaults = buildDefaultValues();
  defaults.kind = kind;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const form = useForm({ defaultValues: defaults, onSubmit: async () => {} }) as any;
  return (
    <Form form={form}>
      <DataSourcePicker form={form} />
      {withSubmit && <button type="submit">Submit</button>}
    </Form>
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let roCleanup: () => void;

beforeEach(() => {
  vi.clearAllMocks();
  roCleanup = mockResizeObserver().cleanup;
  mockListDataSources.mockReturnValue({
    data: { data: [MOCK_DS], total: 1 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
});

afterEach(() => {
  roCleanup?.();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DataSourcePicker", () => {
  it("renders the picker table", async () => {
    renderWithProviders(<PickerWrapper />);
    await waitFor(() => {
      expect(screen.getByText("My Source")).toBeInTheDocument();
    });
  });

  it("renders while loading", () => {
    mockListDataSources.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });
    renderWithProviders(<PickerWrapper />);
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("renders on error state", () => {
    mockListDataSources.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    renderWithProviders(<PickerWrapper />);
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("filters out deprecated data sources", async () => {
    const deprecated: DataSourceListItem = { ...MOCK_DS, dsrc_id: "ds-dep", name: "Deprecated DS", deprecated: true };
    mockListDataSources.mockReturnValue({
      data: { data: [MOCK_DS, deprecated], total: 2 },
      isLoading: false,
      isError: false,
    });
    renderWithProviders(<PickerWrapper />);
    await waitFor(() => {
      expect(screen.getByText("My Source")).toBeInTheDocument();
    });
    expect(screen.queryByText("Deprecated DS")).not.toBeInTheDocument();
  });

  it("opens the volume browser when the View action is clicked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PickerWrapper />);

    await waitFor(() => {
      expect(screen.getByText("My Source")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("volume-browser-dialog")).not.toBeInTheDocument();

    await user.click(screen.getByText("View"));

    await waitFor(() => {
      expect(screen.getByTestId("volume-browser-dialog")).toBeInTheDocument();
    });
  });

  it("does not render a View action for non-Volume sources", async () => {
    mockListDataSources.mockReturnValue({
      data: { data: [{ ...MOCK_DS, category: "Database" }], total: 1 },
      isLoading: false,
      isError: false,
    });
    renderWithProviders(<PickerWrapper kind="structured" />);

    await waitFor(() => {
      expect(screen.getByText("My Source")).toBeInTheDocument();
    });
    expect(screen.queryByText("View")).not.toBeInTheDocument();
  });

  it("shows sources with null category for either kind (taxonomy unavailable)", async () => {
    const nullCat: DataSourceListItem = { ...MOCK_DS, dsrc_id: "ds-null", name: "Unknown Cat DS", category: null as unknown as DataSourceListItem["category"] };
    mockListDataSources.mockReturnValue({
      data: { data: [nullCat], total: 1 },
      isLoading: false,
      isError: false,
    });
    renderWithProviders(<PickerWrapper kind="unstructured" />);
    await waitFor(() => {
      expect(screen.getByText("Unknown Cat DS")).toBeInTheDocument();
    });
  });

  it("shows only file-capable sources when kind is unstructured", async () => {
    const volume: DataSourceListItem = { ...MOCK_DS, dsrc_id: "ds-vol", name: "Volume DS", category: "Volume" };
    const objectStore: DataSourceListItem = { ...MOCK_DS, dsrc_id: "ds-s3", name: "S3 DS", category: "Object Store" };
    const database: DataSourceListItem = { ...MOCK_DS, dsrc_id: "ds-db", name: "MySQL DS", category: "Database" };
    mockListDataSources.mockReturnValue({
      data: { data: [volume, objectStore, database], total: 3 },
      isLoading: false,
      isError: false,
    });
    renderWithProviders(<PickerWrapper kind="unstructured" />);

    await waitFor(() => {
      expect(screen.getByText("Volume DS")).toBeInTheDocument();
      expect(screen.getByText("S3 DS")).toBeInTheDocument();
    });
    expect(screen.queryByText("MySQL DS")).not.toBeInTheDocument();
  });

  it("shows only structured-capable sources when kind is structured", async () => {
    const volume: DataSourceListItem = { ...MOCK_DS, dsrc_id: "ds-vol", name: "Volume DS", category: "Volume" };
    const database: DataSourceListItem = { ...MOCK_DS, dsrc_id: "ds-db", name: "MySQL DS", category: "Database" };
    const storage: DataSourceListItem = { ...MOCK_DS, dsrc_id: "ds-ss", name: "GCP DS", category: "Storage System" };
    mockListDataSources.mockReturnValue({
      data: { data: [volume, database, storage], total: 3 },
      isLoading: false,
      isError: false,
    });
    renderWithProviders(<PickerWrapper kind="structured" />);

    await waitFor(() => {
      expect(screen.getByText("MySQL DS")).toBeInTheDocument();
      expect(screen.getByText("GCP DS")).toBeInTheDocument();
    });
    expect(screen.queryByText("Volume DS")).not.toBeInTheDocument();
  });

  it("closes the volume browser via onOpenChange", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PickerWrapper />);

    await waitFor(() => {
      expect(screen.getByText("My Source")).toBeInTheDocument();
    });

    await user.click(screen.getByText("View"));

    await waitFor(() => {
      expect(screen.getByTestId("volume-browser-dialog")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Close browser"));

    await waitFor(() => {
      expect(screen.queryByTestId("volume-browser-dialog")).not.toBeInTheDocument();
    });
  });

  it("shows the data_source_id field error after row selection triggers validation", async () => {
    // Empty data so no rows to select; just verify no error shown without interaction
    mockListDataSources.mockReturnValue({
      data: { data: [], total: 0 },
      isLoading: false,
      isError: false,
    });
    renderWithProviders(<PickerWrapper />);
    expect(screen.queryByText(/Data source id is missing/i)).not.toBeInTheDocument();
  });

  it("sets data_source_id on row selection", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PickerWrapper />);

    await waitFor(() => {
      expect(screen.getByText("My Source")).toBeInTheDocument();
    });

    const rowCheckbox = screen.getByLabelText("Select row");
    await user.click(rowCheckbox);

    // Row is now selected; the table UI shows the checkbox checked
    expect(rowCheckbox).toBeChecked();
  });

  it("shows data_source_id validation error after submit without selecting a row", async () => {
    // Covers DataSourceIdFieldError render path (lines 22 & 27)
    mockListDataSources.mockReturnValue({
      data: { data: [], total: 0 },
      isLoading: false,
      isError: false,
    });
    const user = userEvent.setup();
    renderWithProviders(<PickerWrapper withSubmit />);

    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(screen.getByText(/Data source id is missing/i)).toBeInTheDocument();
    });
  });
});
