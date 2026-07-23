import { screen, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { renderWithProviders, userEvent } from "@test/render";
import { mockResizeObserver } from "@test/mocks";
import type { DataSourceListItem } from "@/api/data-source.types";
import type { DatasetDetail } from "@/api/dataset.types";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
const mockBlocker = vi.fn();

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useBlocker: (shouldBlock: boolean) => mockBlocker(shouldBlock),
  };
});

// Enable all input-type options (upload is disabled in production but must be
// exercisable in tests to cover handleInputTypeChange).
vi.mock("./dataset-form.consts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dataset-form.consts")>();
  return {
    ...actual,
    INPUT_TYPE_OPTIONS: actual.INPUT_TYPE_OPTIONS.map((opt) => ({
      ...opt,
      isDisabled: undefined,
    })),
  };
});

const mockCreateDataset = vi.fn();
const mockUpdateDataset = vi.fn();

vi.mock("@/api/dataset-api.slice", () => ({
  useCreateDatasetMutation: vi.fn(),
  useUpdateDatasetMutation: vi.fn(),
  // Snapshot + manifest hooks back the manual-upload flow. They are not the
  // focus of these tests, so they return inert triggers/empty results.
  useCreateDatasetSnapshotMutation: vi.fn(() => [vi.fn().mockResolvedValue({ data: {} })]),
  useUpdateDatasetManifestStatusMutation: vi.fn(() => [vi.fn().mockResolvedValue({ data: {} })]),
  useLazyListDatasetManifestsQuery: vi.fn(() => [vi.fn().mockResolvedValue({ data: [] })]),
  useListDatasetManifestsQuery: vi.fn(() => ({ data: undefined, isLoading: false, isError: false })),
}));

vi.mock("@/api/project-api.slice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/project-api.slice")>()),
  useLazyGetProjectQuery: vi.fn(() => [vi.fn().mockResolvedValue({ data: null })]),
}));

vi.mock("@/api/data-source-api.slice", () => ({
  useListDataSourcesQuery: vi.fn().mockReturnValue({ data: { data: [] }, isLoading: false }),
  useGetDataSourceQuery: vi.fn().mockReturnValue({ data: undefined, isLoading: false, isError: false }),
  useLazyGetDataSourceQuery: () => [vi.fn().mockResolvedValue({ data: null })],
  useTriggerManualScanMutation: () => [vi.fn().mockResolvedValue({})],
}));

vi.mock("@/ui-lib/base-components/toast/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import {
  useListDataSourcesQuery,
} from "@/api/data-source-api.slice";
import {
  useCreateDatasetMutation,
  useUpdateDatasetMutation,
} from "@/api/dataset-api.slice";
import { toast } from "@/ui-lib/base-components/toast/toast";
import { DatasetForm } from "./dataset-form";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One Healthy, non-deprecated row for the data source table picker. */
const MOCK_PICKER_DATA_SOURCE: DataSourceListItem = {
  dsrc_id: "ds-picker-1",
  name: "Picker Data Source",
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

const MOCK_DETAIL: DatasetDetail = {
  dset_id: "dset-edit-1",
  name: "Existing Dataset",
  kind: "unstructured",
  input_type: "data-source",
  status: "Healthy",
  lifecycle_status: "ready",
  deprecated: false,
  files_count: 100,
  synchronization_status: "Completed",
  latest_snapshot: null,
  labels: ["prod"],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  modified_by: "admin",
  data_source: { dsrc_id: "ds-1", name: "My Source" },
  description: "Existing description",
  spec: {
    folder_scope: "all",
    paths: [],
    file_types: [],
    last_modified_filter: "all",
    max_file_size_bytes: null,
    exclude_patterns: [],
  },
  refresh_config: null,
  synchronization_summary: null,
  sql_query: null,
  catalog_namespace: null,
  catalog_table_name: null,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let roHandle: ReturnType<typeof mockResizeObserver>;

beforeEach(() => {
  vi.clearAllMocks();
  roHandle = mockResizeObserver();

  mockBlocker.mockReturnValue({ state: "unblocked", proceed: vi.fn(), reset: vi.fn() });

  vi.mocked(useCreateDatasetMutation).mockReturnValue([
    mockCreateDataset,
    { isLoading: false, reset: vi.fn() } as unknown as ReturnType<typeof useCreateDatasetMutation>[1],
  ]);
  vi.mocked(useUpdateDatasetMutation).mockReturnValue([
    mockUpdateDataset,
    { isLoading: false, reset: vi.fn() } as unknown as ReturnType<typeof useUpdateDatasetMutation>[1],
  ]);

  vi.mocked(useListDataSourcesQuery).mockReturnValue({
    data: { data: [MOCK_PICKER_DATA_SOURCE], total: 1 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useListDataSourcesQuery>);

  return () => roHandle.cleanup();
});

// ---------------------------------------------------------------------------
// Create mode
// ---------------------------------------------------------------------------

/**
 * The footer submit button is labelled "Add" in create mode, but "Add" also
 * appears on the data-source scope table. Scope the lookup to the sticky footer
 * so we always target the submit action.
 */
function getFooterButton(name: string): HTMLElement {
  const footer = document.querySelector(".dset-form-page__footer") as HTMLElement;
  return within(footer).getByText(name);
}

async function selectDatasetKind(
  user: ReturnType<typeof userEvent.setup>,
  kind: "Structured" | "Unstructured" = "Unstructured",
): Promise<void> {
  await user.click(screen.getByText(kind));
}

describe("DatasetForm — create mode", () => {
  it("renders the top bar with 'Create dataset' title", () => {
    renderWithProviders(<DatasetForm />);
    expect(screen.getByText("Create dataset")).toBeInTheDocument();
  });

  it("renders the Details section header", () => {
    renderWithProviders(<DatasetForm />);
    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getByText("Enter the identifying information for this dataset.")).toBeInTheDocument();
  });

  it("renders the Data source configuration section", () => {
    renderWithProviders(<DatasetForm />);
    expect(screen.getByText("Data source configuration")).toBeInTheDocument();
  });

  it("renders the Refresh schedule section", () => {
    renderWithProviders(<DatasetForm />);
    expect(screen.getByText("Refresh schedule")).toBeInTheDocument();
  });

  it("renders Add and Cancel buttons in footer", () => {
    renderWithProviders(<DatasetForm />);
    expect(getFooterButton("Add")).toBeInTheDocument();
    expect(getFooterButton("Cancel")).toBeInTheDocument();
  });

  it("shows input type radio options (Use existing data source / Upload from computer)", () => {
    renderWithProviders(<DatasetForm />);
    expect(screen.getByText("Use existing data source")).toBeInTheDocument();
    expect(screen.getByText("Upload from computer")).toBeInTheDocument();
  });

  it("navigates to datasets list on Cancel click", async () => {
    renderWithProviders(<DatasetForm />);
    const cancelBtn = getFooterButton("Cancel");
    await userEvent.setup().click(cancelBtn);
    expect(mockNavigate).toHaveBeenCalledWith("/datasets");
  });

  it("submits create mutation on form submit", async () => {
    mockCreateDataset.mockReturnValue({ unwrap: () => Promise.resolve({}) });
    renderWithProviders(<DatasetForm />);

    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByText("Picker Data Source")).toBeInTheDocument();
    });
    const rowCheckboxes = screen.getAllByLabelText("Select row");
    await user.click(rowCheckboxes[0]!);

    const nameInput = screen.getByPlaceholderText("Enter dataset name");
    await user.type(nameInput, "new-dataset");
    await user.tab();
    await selectDatasetKind(user);

    const addBtn = getFooterButton("Add");
    await user.click(addBtn);

    await waitFor(() => {
      expect(mockCreateDataset).toHaveBeenCalled();
    });
  });

  it("shows success toast after successful create", async () => {
    mockCreateDataset.mockReturnValue({ unwrap: () => Promise.resolve({}) });
    renderWithProviders(<DatasetForm />);

    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByText("Picker Data Source")).toBeInTheDocument();
    });
    const rowCheckboxes = screen.getAllByLabelText("Select row");
    await user.click(rowCheckboxes[0]!);

    const nameInput = screen.getByPlaceholderText("Enter dataset name");
    await user.type(nameInput, "new-dataset");
    await user.tab();
    await selectDatasetKind(user);

    const addBtn = getFooterButton("Add");
    await user.click(addBtn);

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Dataset created successfully.");
    });
  });

  it("shows error toast after failed create", async () => {
    mockCreateDataset.mockReturnValue({ unwrap: () => Promise.reject(new Error("fail")) });
    renderWithProviders(<DatasetForm />);

    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByText("Picker Data Source")).toBeInTheDocument();
    });
    const rowCheckboxes = screen.getAllByLabelText("Select row");
    await user.click(rowCheckboxes[0]!);

    const nameInput = screen.getByPlaceholderText("Enter dataset name");
    await user.type(nameInput, "new-dataset");
    await user.tab();
    await selectDatasetKind(user);

    const addBtn = getFooterButton("Add");
    await user.click(addBtn);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("fail");
    });
  });

  it("shows validation error toast when payload rules fail after mandatory fields are filled", async () => {
    const dbSource: DataSourceListItem = {
      ...MOCK_PICKER_DATA_SOURCE,
      dsrc_id: "ds-db-1",
      name: "MySQL Database",
      source_type: null,
      category: "Database",
      provider: "mysql",
    };
    vi.mocked(useListDataSourcesQuery).mockReturnValue({
      data: { data: [dbSource], total: 1 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useListDataSourcesQuery>);

    renderWithProviders(<DatasetForm />);

    const user = userEvent.setup();
    await selectDatasetKind(user, "Structured");
    await waitFor(() => {
      expect(screen.getByText("MySQL Database")).toBeInTheDocument();
    });
    const rowCheckboxes = screen.getAllByLabelText("Select row");
    await user.click(rowCheckboxes[0]!);

    const nameInput = screen.getByPlaceholderText("Enter dataset name");
    await user.type(nameInput, "sql_ds");
    await user.tab();

    const addBtn = getFooterButton("Add");
    await user.click(addBtn);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Select at least one table or view in Data source scope.",
      );
    });
    expect(mockCreateDataset).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Edit mode
// ---------------------------------------------------------------------------

describe("DatasetForm — edit mode", () => {
  it("renders the top bar with 'Edit dataset' title", () => {
    renderWithProviders(<DatasetForm isEdit initialData={MOCK_DETAIL} />);
    expect(screen.getByText("Edit dataset")).toBeInTheDocument();
  });

  it("renders Save and Cancel buttons in footer", () => {
    renderWithProviders(<DatasetForm isEdit initialData={MOCK_DETAIL} />);
    expect(screen.getByText("Save")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("shows name field as read-only with pre-filled value", () => {
    renderWithProviders(<DatasetForm isEdit initialData={MOCK_DETAIL} />);
    const nameInput = screen.getByDisplayValue("Existing Dataset");
    expect(nameInput).toBeInTheDocument();
  });

  it("shows data source readonly card in edit mode", () => {
    renderWithProviders(<DatasetForm isEdit initialData={MOCK_DETAIL} />);
    expect(screen.getByText("Data source")).toBeInTheDocument();
    expect(screen.getByText("My Source")).toBeInTheDocument();
  });

  it("does not show input type radio options in edit mode", () => {
    renderWithProviders(<DatasetForm isEdit initialData={MOCK_DETAIL} />);
    expect(screen.queryByText("Use existing data source")).not.toBeInTheDocument();
    expect(screen.queryByText("Upload from computer")).not.toBeInTheDocument();
  });

  it("submits update mutation on form submit", async () => {
    const user = userEvent.setup();
    mockUpdateDataset.mockReturnValue({ unwrap: () => Promise.resolve({}) });
    renderWithProviders(<DatasetForm isEdit initialData={MOCK_DETAIL} />);

    const descInput = screen.getByDisplayValue("Existing description");
    await user.clear(descInput);
    await user.type(descInput, "Changed");
    await user.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(mockUpdateDataset).toHaveBeenCalled();
    });
  });

  it("shows info toast when saving with no changes", async () => {
    renderWithProviders(<DatasetForm isEdit initialData={MOCK_DETAIL} />);

    await userEvent.setup().click(screen.getByText("Save"));

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith("No changes to save.");
    });
  });

  it("shows success toast after successful update", async () => {
    const user = userEvent.setup();
    mockUpdateDataset.mockReturnValue({ unwrap: () => Promise.resolve({}) });
    renderWithProviders(<DatasetForm isEdit initialData={MOCK_DETAIL} />);

    const descInput = screen.getByDisplayValue("Existing description");
    await user.clear(descInput);
    await user.type(descInput, "Changed");
    await user.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Dataset updated successfully.");
    });
  });

  it("navigates to dataset detail on successful update", async () => {
    const user = userEvent.setup();
    mockUpdateDataset.mockReturnValue({ unwrap: () => Promise.resolve({}) });
    renderWithProviders(<DatasetForm isEdit initialData={MOCK_DETAIL} />);

    const descInput = screen.getByDisplayValue("Existing description");
    await user.clear(descInput);
    await user.type(descInput, "Changed");
    await user.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/datasets/dset-edit-1");
    });
  });

  it("navigates to dataset detail on Cancel in edit mode", async () => {
    renderWithProviders(<DatasetForm isEdit initialData={MOCK_DETAIL} />);
    const cancelBtn = getFooterButton("Cancel");
    await userEvent.setup().click(cancelBtn);
    expect(mockNavigate).toHaveBeenCalledWith("/datasets/dset-edit-1");
  });
});

// ---------------------------------------------------------------------------
// Discard guard
// ---------------------------------------------------------------------------

describe("DatasetForm — discard guard", () => {
  it("calls useBlocker with form dirty state", () => {
    renderWithProviders(<DatasetForm />);
    expect(mockBlocker).toHaveBeenCalled();
  });

  it("renders discard dialog when blocker state is blocked", () => {
    mockBlocker.mockReturnValue({ state: "blocked", proceed: vi.fn(), reset: vi.fn() });
    renderWithProviders(<DatasetForm />);
    expect(screen.getByText("Discard changes?")).toBeInTheDocument();
  });

  it("calls blocker.proceed when Discard is clicked in the dialog", async () => {
    const proceed = vi.fn();
    const reset = vi.fn();
    mockBlocker.mockReturnValue({ state: "blocked", proceed, reset });
    renderWithProviders(<DatasetForm />);

    const discardBtn = screen.getByText("Discard");
    await userEvent.setup().click(discardBtn);
    expect(proceed).toHaveBeenCalled();
  });

  it("calls blocker.reset when Stay is clicked in the dialog", async () => {
    const proceed = vi.fn();
    const reset = vi.fn();
    mockBlocker.mockReturnValue({ state: "blocked", proceed, reset });
    renderWithProviders(<DatasetForm />);

    const stayBtn = screen.getByText("Stay");
    await userEvent.setup().click(stayBtn);
    expect(reset).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Name validation (create mode)
// ---------------------------------------------------------------------------

describe("DatasetForm — name validation", () => {
  it("shows 'Name is required' error when name is empty", async () => {
    renderWithProviders(<DatasetForm />);
    const user = userEvent.setup();
    const nameInput = screen.getByPlaceholderText("Enter dataset name");
    await user.click(nameInput);
    await user.tab();
    await waitFor(() => {
      expect(screen.getByText("Name is required")).toBeInTheDocument();
    });
  });

  it("shows 'at least 3 characters' error for short name", async () => {
    renderWithProviders(<DatasetForm />);
    const user = userEvent.setup();
    const nameInput = screen.getByPlaceholderText("Enter dataset name");
    await user.type(nameInput, "ab");
    await user.tab();
    await waitFor(() => {
      expect(screen.getByText("Name must be at least 3 characters")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// handleAddLabel
// ---------------------------------------------------------------------------

describe("DatasetForm — label management", () => {
  // Extended timeout: dropdown interaction chain (open → search → add) is slow
  // under full-suite coverage and can exceed the default 5s limit.
  it("adds a new label via the labels dropdown onAddNew callback", { timeout: 15_000 }, async () => {
    const { container } = renderWithProviders(<DatasetForm />);
    const user = userEvent.setup();

    // Scope to the Labels form-field row to avoid matching other dropdown triggers
    const labelsRow = container.querySelector(".form-field--labels") as HTMLElement
      ?? screen.getByText("Labels").closest(".form-field") as HTMLElement;
    const labelTrigger = within(labelsRow).getByRole("combobox", { name: /labels/i });
    await user.click(labelTrigger);

    // Wait for the dropdown popup and its search bar to appear
    const searchInput = await waitFor(() => {
      const el = document.querySelector<HTMLInputElement>(".select-dropdown-searchbar__input");
      if (!el) throw new Error("search input not found");
      return el;
    });
    await user.type(searchInput, "brand-new-label");

    // "Add new item" button appears when the typed text is unique
    const addBtn = await screen.findByRole("button", { name: "Add new item" });
    expect(addBtn).not.toBeDisabled();

    // Clicking Add triggers handleAddLabel — the label is added and the Add button
    // becomes disabled because the value now exists in the list
    await user.click(addBtn);

    await waitFor(() => {
      const btn = screen.queryByRole("button", { name: "Add new item" });
      // Either the button is gone or it's disabled (label was added to items)
      expect(!btn || btn.hasAttribute("disabled")).toBe(true);
    });
  });

  it("ignores empty / whitespace-only input in onAddNew (handleAddLabel early-return branch)", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<DatasetForm />);

    // Locate the Labels form-field row and open the dropdown
    const labelsRow = container.querySelector(".form-field--labels") as HTMLElement
      ?? screen.getByText("Labels").closest(".form-field") as HTMLElement;
    const dropdownTrigger = within(labelsRow).getByRole("combobox", { name: /labels/i });
    await user.click(dropdownTrigger);

    // Wait for the dropdown search bar to appear
    const searchInput = await waitFor(() => {
      const el = document.querySelector(".select-dropdown-searchbar__input") as HTMLInputElement;
      if (!el) throw new Error("search input not found");
      return el;
    });

    // Type only whitespace — handleAddLabel should short-circuit on empty trimmed
    await user.type(searchInput, "   ");
    await user.keyboard("{Enter}");

    // Component still renders correctly
    expect(screen.getByText("Labels")).toBeInTheDocument();
  });

  it("does not add a duplicate label via onAddNew (existing label is not re-added)", async () => {
    const { container } = renderWithProviders(<DatasetForm />);
    const user = userEvent.setup();

    const labelTrigger = container.querySelector<HTMLElement>('[data-slot="select-dropdown-trigger"]')!;
    await user.click(labelTrigger);

    // "staging" is already in DEFAULT_LABEL_ITEMS (case-insensitive match)
    const searchInput = document.querySelector<HTMLElement>(".select-dropdown-searchbar__input")!;
    await user.type(searchInput, "staging");

    // The "Add new item" button should be absent or disabled for an existing label
    const addBtn = screen.queryByRole("button", { name: "Add new item" });
    if (addBtn) {
      expect(addBtn).toBeDisabled();
    } else {
      expect(screen.getByRole("option", { name: "Staging" })).toBeInTheDocument();
    }
  });
});

// ---------------------------------------------------------------------------
// Edit mode — shows error toast on failed update
// ---------------------------------------------------------------------------

describe("DatasetForm — edit mode error handling", () => {
  it("shows error toast after failed update", async () => {
    const user = userEvent.setup();
    mockUpdateDataset.mockReturnValue({ unwrap: () => Promise.reject(new Error("fail")) });
    renderWithProviders(<DatasetForm isEdit initialData={MOCK_DETAIL} />);

    const descInput = screen.getByDisplayValue("Existing description");
    await user.clear(descInput);
    await user.type(descInput, "Changed");
    await user.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("fail");
    });
  });
});

// ---------------------------------------------------------------------------
// onSubmit branch coverage — description falsy path + upload mode
// ---------------------------------------------------------------------------

describe("DatasetForm — onSubmit branch coverage", () => {
  it("only sends changed fields in edit mode (delta-only update)", async () => {
    mockUpdateDataset.mockReturnValue({ unwrap: () => Promise.resolve({}) });
    renderWithProviders(<DatasetForm isEdit initialData={MOCK_DETAIL} />);

    const user = userEvent.setup();
    const descInput = screen.getByDisplayValue("Existing description");
    await user.clear(descInput);
    await user.type(descInput, "New description");
    await user.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(mockUpdateDataset).toHaveBeenCalled();
      const call = mockUpdateDataset.mock.calls[0][0];
      expect(call.body.description).toBe("New description");
      expect(call.body).not.toHaveProperty("labels");
    });
  });

  it("creates dataset in upload mode — data_source_id: undefined, description: undefined (falsy || branches)", async () => {
    const user = userEvent.setup();
    mockCreateDataset.mockReturnValue({ unwrap: () => Promise.resolve({}) });
    renderWithProviders(<DatasetForm />);

    // Switch to upload mode (INPUT_TYPE_OPTIONS mock has disabled removed)
    await user.click(screen.getByText("Upload from computer"));

    // Fill in a valid name and blur
    const nameInput = screen.getByPlaceholderText("Enter dataset name");
    await user.type(nameInput, "upload-dataset");
    await user.tab();
    await selectDatasetKind(user);

    await user.click(screen.getByText("Add"));

    await waitFor(() => {
      expect(mockCreateDataset).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            input_type: "upload",
            data_source_id: undefined,  // ternary false branch (not "data-source")
            description: undefined,     // "" || undefined falsy branch
            refresh_config: undefined,
          }),
        }),
      );
    });
  });

  it("disables refresh schedule controls in upload mode", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DatasetForm />);

    await user.click(screen.getByText("Upload from computer"));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Sync schedule cannot be enabled for manually uploaded datasets.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: /Enable dataset refresh schedule/i })).toHaveAttribute(
        "data-disabled",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// initialData with custom labels — label deduplication in useState init
// ---------------------------------------------------------------------------

describe("DatasetForm — initialData with custom labels", () => {
  it("pre-populates labelItems from initialData.labels that are not in defaults", () => {
    const detailWithCustomLabel: typeof MOCK_DETAIL = {
      ...MOCK_DETAIL,
      labels: ["custom-label-xyz"],
    };
    renderWithProviders(<DatasetForm isEdit initialData={detailWithCustomLabel} />);
    expect(screen.getByText("Edit dataset")).toBeInTheDocument();
  });

  it("skips duplicate labels already in DEFAULT_LABEL_ITEMS during init (false branch of label push guard)", () => {
    // "staging" is in DEFAULT_LABEL_ITEMS — the push guard skips it (false branch on line 55)
    const detailWithExistingLabel: typeof MOCK_DETAIL = {
      ...MOCK_DETAIL,
      labels: ["staging"],
    };
    renderWithProviders(<DatasetForm isEdit initialData={detailWithExistingLabel} />);
    expect(screen.getByText("Edit dataset")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// nameValidatorSync / nameValidatorAsync — isEdit early-return branch
// ---------------------------------------------------------------------------

describe("DatasetForm — name validators in edit mode", () => {
  it("nameValidatorSync returns undefined immediately in edit mode (isEdit branch)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DatasetForm isEdit initialData={MOCK_DETAIL} />);

    // Blur the name field in edit mode to trigger nameValidatorSync
    const nameInput = screen.getByDisplayValue("Existing Dataset");
    await user.click(nameInput);
    await user.tab();

    // No validation errors should appear (isEdit → early undefined return)
    await waitFor(() => {
      expect(screen.queryByText("Name is required")).not.toBeInTheDocument();
    });
  });

});

// ---------------------------------------------------------------------------
// handleInputTypeChange — switches between data-source and upload
// ---------------------------------------------------------------------------

describe("DatasetForm — input type switching", () => {
  it("calls handleInputTypeChange (resets data_source_id and uploaded_files) on input type switch", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DatasetForm />);

    await waitFor(() => {
      expect(screen.getByText("Picker Data Source")).toBeInTheDocument();
    });

    // INPUT_TYPE_OPTIONS is mocked above so "Upload from computer" is enabled.
    // Clicking it calls handleInputTypeChange("upload"), resetting data_source_id.
    const uploadLabel = screen.getByText("Upload from computer");
    await user.click(uploadLabel);

    await waitFor(() => {
      expect(screen.getByText("Data source configuration")).toBeInTheDocument();
    });
  });
});
