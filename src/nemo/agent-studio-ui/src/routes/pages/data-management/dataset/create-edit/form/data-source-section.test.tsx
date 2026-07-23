import { screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { renderWithProviders, userEvent } from "@test/render";
import { mockResizeObserver } from "@test/mocks";
import type { DatasetDetail } from "@/api/dataset.types";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@/api/data-source-api.slice", () => ({
  useListDataSourcesQuery: vi.fn().mockReturnValue({ data: { data: [] }, isLoading: false, isError: false }),
  useGetDataSourceQuery: vi.fn().mockReturnValue({ data: undefined, isLoading: false, isError: false }),
  useLazyGetDataSourceQuery: () => [vi.fn().mockResolvedValue({ data: null })],
  useTriggerManualScanMutation: () => [vi.fn().mockResolvedValue({})],
}));

import { DataSourceSection } from "./data-source-section";
import { buildDefaultValues } from "./dataset-form.utils";
import { validateDatasetFormOnSubmit } from "./dataset-form.validation";
import { useForm } from "@tanstack/react-form";
import { Form } from "@/ui-lib/base-components/form";
import { useGetDataSourceQuery } from "@/api/data-source-api.slice";

// The edit-mode data-source card renders details from the *fetched* data source
// (useGetDataSourceQuery), not from the dataset's initialData. Tests that assert
// those details stub this query with a realistic source.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubFetchedDataSource(ds: any): void {
  vi.mocked(useGetDataSourceQuery).mockReturnValue({ data: ds, isLoading: false, isError: false } as never);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FETCHED_DATA_SOURCE: any = {
  dsrc_id: "ds-1",
  name: "NFS Source",
  status: "Healthy",
  deprecated: false,
  category: "Volume",
  source_type: "nfs",
  connection: { region: "us-east-1", credential: "cred-1" },
  labels: ["prod", "nfs"],
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DATA_SOURCE_DETAIL: DatasetDetail = {
  dset_id: "d1",
  name: "My Dataset",
  kind: "unstructured",
  input_type: "data-source",
  status: "Healthy",
  lifecycle_status: "ready",
  deprecated: false,
  files_count: 42,
  synchronization_status: "Completed",
  latest_snapshot: null,
  labels: ["prod", "nfs"],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  modified_by: "admin",
  data_source: { dsrc_id: "ds-1", name: "NFS Source" },
  description: "",
  spec: { folder_scope: "all", paths: [], file_types: [], last_modified_filter: "all", max_file_size_bytes: null, exclude_patterns: [] },
  refresh_config: null,
  synchronization_summary: null,
  sql_query: null,
  catalog_namespace: null,
  catalog_table_name: null,
};

const UPLOAD_DETAIL: DatasetDetail = {
  ...DATA_SOURCE_DETAIL,
  dset_id: "d2",
  input_type: "upload",
  files_count: 7,
  data_source: null,
};

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

function SectionWrapper({
  isEdit = false,
  inputType = "data-source" as "data-source" | "upload",
  initialData,
  onInputTypeChange = vi.fn(),
  withSubmit = false,
  kind = "unstructured" as "" | "structured" | "unstructured",
}: {
  isEdit?: boolean;
  inputType?: "data-source" | "upload";
  initialData?: DatasetDetail;
  onInputTypeChange?: (t: "data-source" | "upload") => void;
  withSubmit?: boolean;
  kind?: "" | "structured" | "unstructured";
}): ReactElement {
  const defaults = buildDefaultValues();
  defaults.input_type = inputType;
  defaults.kind = kind;
  const form = useForm({
    defaultValues: defaults,
    validators: withSubmit ? { onSubmit: validateDatasetFormOnSubmit } : undefined,
    onSubmit: async () => { },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  return (
    <Form form={form}>
      <DataSourceSection
        form={form}
        isEdit={isEdit}
        inputType={inputType}
        onInputTypeChange={onInputTypeChange}
        initialData={initialData}
      />
      {withSubmit ? <button type="submit">Submit</button> : null}
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
});

afterEach(() => {
  roCleanup?.();
});

// ---------------------------------------------------------------------------
// Create mode (isEdit=false)
// ---------------------------------------------------------------------------

describe("DataSourceSection — create mode", () => {
  it("shows 'Data source configuration' header", () => {
    renderWithProviders(<SectionWrapper />);
    expect(screen.getByText("Data source configuration")).toBeInTheDocument();
  });

  it("shows radio options for input type", () => {
    renderWithProviders(<SectionWrapper />);
    expect(screen.getByText("Use existing data source")).toBeInTheDocument();
    expect(screen.getByText("Upload from computer")).toBeInTheDocument();
  });

  it("shows structured and unstructured kind options", () => {
    renderWithProviders(<SectionWrapper />);
    expect(screen.getByText("Dataset kind")).toBeInTheDocument();
    expect(screen.getByText("Unstructured")).toBeInTheDocument();
    expect(screen.getByText("Structured")).toBeInTheDocument();
  });

  it("shows DataSourcePicker when input type is data-source", () => {
    renderWithProviders(<SectionWrapper inputType="data-source" />);
    // BaseTable renders a table element
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("calls onInputTypeChange when radio value changes", async () => {
    const onInputTypeChange = vi.fn();
    const user = userEvent.setup();
    // "Upload from computer" is isDisabled, so render with upload selected
    // and click the enabled "Use existing data source" radio to trigger the callback.
    renderWithProviders(<SectionWrapper inputType="upload" onInputTypeChange={onInputTypeChange} />);

    await user.click(screen.getByText("Use existing data source"));
    expect(onInputTypeChange).toHaveBeenCalled();
  });

  it("shows the create subtitle text", () => {
    renderWithProviders(<SectionWrapper />);
    expect(screen.getByText(/Select an existing data source or upload files/i)).toBeInTheDocument();
  });

  it("shows kind error after submit when kind is not selected", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SectionWrapper inputType="upload" kind="" withSubmit />);

    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(screen.getByText("Dataset kind is required.")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Edit mode — data-source type
// ---------------------------------------------------------------------------

describe("DataSourceSection — edit mode, data-source type", () => {
  it("shows 'Data source' card header", () => {
    stubFetchedDataSource(FETCHED_DATA_SOURCE);
    renderWithProviders(<SectionWrapper isEdit initialData={DATA_SOURCE_DETAIL} inputType="data-source" />);
    expect(screen.getByText("Data source")).toBeInTheDocument();
  });

  it("shows the data source name in the card", () => {
    stubFetchedDataSource(FETCHED_DATA_SOURCE);
    renderWithProviders(<SectionWrapper isEdit initialData={DATA_SOURCE_DETAIL} inputType="data-source" />);
    expect(screen.getByText("NFS Source")).toBeInTheDocument();
  });

  it("shows the data source type (category) from the fetched source", () => {
    stubFetchedDataSource(FETCHED_DATA_SOURCE);
    renderWithProviders(<SectionWrapper isEdit initialData={DATA_SOURCE_DETAIL} inputType="data-source" />);
    expect(screen.getByText("Type")).toBeInTheDocument();
    expect(screen.getByText("Volume")).toBeInTheDocument();
  });

  it("shows labels from the fetched source", () => {
    stubFetchedDataSource(FETCHED_DATA_SOURCE);
    renderWithProviders(<SectionWrapper isEdit initialData={DATA_SOURCE_DETAIL} inputType="data-source" />);
    expect(screen.getByText("prod, nfs")).toBeInTheDocument();
  });

  it("does NOT show radio input-type options in edit mode", () => {
    stubFetchedDataSource(FETCHED_DATA_SOURCE);
    renderWithProviders(<SectionWrapper isEdit initialData={DATA_SOURCE_DETAIL} inputType="data-source" />);
    expect(screen.queryByText("Use existing data source")).not.toBeInTheDocument();
  });

  it("shows the edit (data-source) subtitle text", () => {
    stubFetchedDataSource(FETCHED_DATA_SOURCE);
    renderWithProviders(<SectionWrapper isEdit initialData={DATA_SOURCE_DETAIL} inputType="data-source" />);
    expect(screen.getByText(/Review selected data source to be included/i)).toBeInTheDocument();
  });

  it("shows '—' for the Labels row when the fetched source has empty labels", () => {
    stubFetchedDataSource({ ...FETCHED_DATA_SOURCE, labels: [] });
    renderWithProviders(<SectionWrapper isEdit initialData={DATA_SOURCE_DETAIL} inputType="data-source" />);
    expect(screen.getByText("Labels")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows '—' for name when neither fetched source nor initialData has one", () => {
    stubFetchedDataSource(undefined);
    const detail: DatasetDetail = { ...DATA_SOURCE_DETAIL, data_source: null };
    renderWithProviders(<SectionWrapper isEdit initialData={detail} inputType="data-source" />);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Edit mode — upload type (renders the UploadDropzone)
// ---------------------------------------------------------------------------

describe("DataSourceSection — edit mode, upload type", () => {
  it("renders the upload dropzone header", () => {
    renderWithProviders(<SectionWrapper isEdit initialData={UPLOAD_DETAIL} inputType="upload" />);
    expect(screen.getByRole("heading", { name: "Upload files" })).toBeInTheDocument();
  });

  it("renders the upload-folder action", () => {
    renderWithProviders(<SectionWrapper isEdit initialData={UPLOAD_DETAIL} inputType="upload" />);
    expect(screen.getByText("Upload folder")).toBeInTheDocument();
  });

  it("shows the edit (upload) subtitle text", () => {
    renderWithProviders(<SectionWrapper isEdit initialData={UPLOAD_DETAIL} inputType="upload" />);
    expect(screen.getByText(/Review uploaded file selection/i)).toBeInTheDocument();
  });
});
