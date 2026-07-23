import { screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Mocks — must appear before component imports
// ---------------------------------------------------------------------------

const mockPreviewDataset = vi.fn();
const mockQueryDataset = vi.fn();

vi.mock("@/api/analytics-api", () => ({
  previewDataset: (...args: unknown[]) => mockPreviewDataset(...args),
  queryDataset: (...args: unknown[]) => mockQueryDataset(...args),
}));

vi.mock("@/components/dataset/preview/FilterBuilder", () => ({
  FilterBuilder: ({ onApply, onClear }: { onApply: (f: unknown[]) => void; onClear: () => void }) => (
    <div data-testid="filter-builder">
      <button type="button" data-testid="filter-apply" onClick={() => onApply([{ column: "col1", op: "=", value: "x" }])}>
        Apply
      </button>
      <button type="button" data-testid="filter-clear" onClick={onClear}>
        Clear
      </button>
    </div>
  ),
}));

vi.mock("@/components/dataset/preview/ColumnFilterPopover", () => ({
  ColumnFilterPopover: () => <div data-testid="column-filter-popover" />,
}));

vi.mock("@/components/dataset/preview/PreviewTable", () => ({
  PreviewTable: ({
    columns,
    rows,
    loading,
  }: {
    columns: string[];
    rows: unknown[];
    loading: boolean;
  }) => (
    <div data-testid="preview-table">
      {loading && <span data-testid="table-loading">Loading…</span>}
      <span data-testid="col-count">{columns.length}</span>
      <span data-testid="row-count">{rows.length}</span>
    </div>
  ),
}));

vi.mock("@/components/sql-monaco-editor/sql-monaco-editor", () => ({
  SQLMonacoEditor: ({
    value,
    onChange,
    onExecute,
    onBlur,
    hasError,
    ariaLabel = "SQL query",
  }: {
    value: string;
    onChange?: (value: string) => void;
    onExecute?: () => void;
    onBlur?: () => void;
    hasError?: boolean;
    ariaLabel?: string;
  }) => (
    <textarea
      aria-label={ariaLabel}
      aria-invalid={hasError || undefined}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      onBlur={() => onBlur?.()}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onExecute?.();
        }
      }}
    />
  ),
}));

// ---------------------------------------------------------------------------
// Component import (must follow mocks)
// ---------------------------------------------------------------------------

import { renderWithProviders } from "@test/render";
import { DatasetDetailDataPreview } from "./dataset-detail-data-preview";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PREVIEW_RESPONSE = {
  columns: ["id", "name"],
  columnTypes: ["BIGINT", "VARCHAR"],
  rows: [
    [1, "Alice"],
    [2, "Bob"],
  ],
  totalCount: 2,
  rowCount: 2,
};

function renderPreview(
  props: Partial<Parameters<typeof DatasetDetailDataPreview>[0]> = {},
) {
  return renderWithProviders(
    <DatasetDetailDataPreview
      dsetId="ds-1"
      namespace="ns"
      catalogTableName="my_table"
      isReady={true}
      {...props}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests — "not ready" / "no coords" states
// ---------------------------------------------------------------------------

describe("DatasetDetailDataPreview — not-ready states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreviewDataset.mockResolvedValue(PREVIEW_RESPONSE);
  });

  it("[tag:data-preview] shows 'no catalog table' message when namespace is missing", () => {
    renderPreview({ namespace: null, catalogTableName: null, isReady: true });

    expect(
      screen.getByText(/preview is not available.*no catalog table/i),
    ).toBeInTheDocument();
  });

  it("[tag:data-preview] shows importing spinner when isReady=false and catalog coords exist", () => {
    renderPreview({ isReady: false });

    expect(screen.getByTestId("dset-preview-importing")).toBeInTheDocument();
    expect(screen.getByText(/importing dataset files/i)).toBeInTheDocument();
  });

  it("[tag:data-preview] shows 'no catalog table' when coords missing even if isReady=false", () => {
    renderPreview({ namespace: null, catalogTableName: null, isReady: false });

    expect(screen.queryByTestId("dset-preview-importing")).not.toBeInTheDocument();
    expect(
      screen.getByText(/preview is not available.*no catalog table/i),
    ).toBeInTheDocument();
  });

  it("[tag:data-preview] does not call previewDataset when isReady=false", () => {
    renderPreview({ isReady: false });

    expect(mockPreviewDataset).not.toHaveBeenCalled();
  });

  it("[tag:data-preview] does not call previewDataset when namespace is missing", () => {
    renderPreview({ namespace: null, catalogTableName: null });

    expect(mockPreviewDataset).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — visual tab (happy path)
// ---------------------------------------------------------------------------

describe("DatasetDetailDataPreview — visual tab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreviewDataset.mockResolvedValue(PREVIEW_RESPONSE);
  });

  it("[tag:data-preview][tag:visual] renders the tab group with Visual and Query tabs", () => {
    renderPreview();

    expect(screen.getByRole("tab", { name: /visual/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /query/i })).toBeInTheDocument();
  });

  it("[tag:data-preview][tag:visual] calls previewDataset on mount", async () => {
    renderPreview();

    await waitFor(() => {
      expect(mockPreviewDataset).toHaveBeenCalledWith("ns", "my_table", expect.any(Object));
    });
  });

  it("[tag:data-preview][tag:visual] renders the preview table after data loads", async () => {
    renderPreview();

    await waitFor(() => {
      expect(screen.getByTestId("preview-table")).toBeInTheDocument();
      // Assert the counts inside waitFor: the table element mounts a tick
      // before the async preview state populates the col/row counts, so under
      // CI load a bare assertion here races and reads 0 (flaky).
      expect(screen.getByTestId("col-count")).toHaveTextContent("2");
      expect(screen.getByTestId("row-count")).toHaveTextContent("2");
    });
  });

  it("[tag:data-preview][tag:visual] renders FilterBuilder when preview is ready", async () => {
    renderPreview();

    await waitFor(() => {
      expect(screen.getByTestId("filter-builder")).toBeInTheDocument();
    });
  });

  it("[tag:data-preview][tag:visual] shows error message when previewDataset fails", async () => {
    mockPreviewDataset.mockRejectedValue(new Error("connection refused"));

    renderPreview();

    await waitFor(() => {
      expect(screen.getByText(/connection refused/i)).toBeInTheDocument();
    });
  });

  it("[tag:data-preview][tag:visual] shows friendly hint for table-missing error", async () => {
    mockPreviewDataset.mockRejectedValue(new Error("Table with name my_table does not exist"));

    renderPreview();

    await waitFor(() => {
      expect(
        screen.getByText(/hasn't been imported yet/i),
      ).toBeInTheDocument();
    });
  });

  it("[tag:data-preview][tag:visual] shows raw error for missing iceberg metadata (HTTP 404), not 'not imported yet'", async () => {
    mockPreviewDataset.mockRejectedValue(
      new Error("Analytics API error 400: DESCRIBE failed: HTTP GET error on 's3://bucket/metadata/snap.avro' (HTTP 404)"),
    );

    renderPreview();

    await waitFor(() => {
      expect(screen.getByText(/HTTP 404/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/hasn't been imported yet/i)).not.toBeInTheDocument();
  });

  it("[tag:data-preview][tag:visual] shows raw error for catalog auth failures, not 'not imported yet'", async () => {
    mockPreviewDataset.mockRejectedValue(
      new Error('Analytics API error 400: {"detail":"Invalid filter/sort: DESCRIBE failed: HTTP Error: Unauthorized"}'),
    );

    renderPreview();

    await waitFor(() => {
      expect(screen.queryByText(/hasn't been imported yet/i)).not.toBeInTheDocument();
      expect(screen.getByText(/Unauthorized/i)).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — visual tab filter interactions
// ---------------------------------------------------------------------------

describe("DatasetDetailDataPreview — visual filters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreviewDataset.mockResolvedValue(PREVIEW_RESPONSE);
  });

  it("[tag:data-preview][tag:filters] applying filters re-calls previewDataset", async () => {
    renderPreview();

    await waitFor(() => expect(screen.getByTestId("filter-builder")).toBeInTheDocument());

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("filter-apply"));

    await waitFor(() => {
      // Called once on mount and once after filter apply
      expect(mockPreviewDataset).toHaveBeenCalledTimes(2);
    });
  });

  it("[tag:data-preview][tag:filters] clearing filters re-calls previewDataset", async () => {
    renderPreview();

    await waitFor(() => expect(screen.getByTestId("filter-builder")).toBeInTheDocument());

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("filter-clear"));

    await waitFor(() => {
      expect(mockPreviewDataset).toHaveBeenCalledTimes(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — query (SQL) tab
// ---------------------------------------------------------------------------

describe("DatasetDetailDataPreview — query tab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreviewDataset.mockResolvedValue(PREVIEW_RESPONSE);
    mockQueryDataset.mockResolvedValue({
      ...PREVIEW_RESPONSE,
      rowCount: 2,
    });
  });

  it("[tag:data-preview][tag:sql] clicking Query tab renders SQL editor", async () => {
    renderPreview();

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("tab", { name: /query/i }));

    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /clear/i })).toBeInTheDocument();
  });

  it("[tag:data-preview][tag:sql] run button is disabled when textarea is empty", async () => {
    renderPreview();

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("tab", { name: /query/i }));

    expect(screen.getByRole("button", { name: /run/i })).toBeDisabled();
  });

  it("[tag:data-preview][tag:sql] typing in textarea enables run button", async () => {
    renderPreview();

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("tab", { name: /query/i }));
    await user.type(screen.getByRole("textbox"), "SELECT 1");

    expect(screen.getByRole("button", { name: /run/i })).not.toBeDisabled();
  });

  it("[tag:data-preview][tag:sql] running a query calls queryDataset", async () => {
    renderPreview();

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("tab", { name: /query/i }));
    await user.type(screen.getByRole("textbox"), "SELECT 1");
    await user.click(screen.getByRole("button", { name: /run/i }));

    await waitFor(() => {
      expect(mockQueryDataset).toHaveBeenCalledWith("SELECT 1");
    });
  });

  it("[tag:data-preview][tag:sql] shows query time after successful run", async () => {
    renderPreview();

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("tab", { name: /query/i }));
    await user.type(screen.getByRole("textbox"), "SELECT 1");
    await user.click(screen.getByRole("button", { name: /run/i }));

    await waitFor(() => {
      expect(screen.getByText(/query time/i)).toBeInTheDocument();
    });
  });

  it("[tag:data-preview][tag:sql] shows 'Query failed' on queryDataset error", async () => {
    mockQueryDataset.mockRejectedValue(new Error("bad sql"));

    renderPreview();

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("tab", { name: /query/i }));
    await user.type(screen.getByRole("textbox"), "BAD SQL");
    await user.click(screen.getByRole("button", { name: /run/i }));

    await waitFor(() => {
      expect(screen.getByText(/query failed/i)).toBeInTheDocument();
    });
  });

  it("[tag:data-preview][tag:sql] clear button resets SQL editor", async () => {
    renderPreview();

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("tab", { name: /query/i }));
    await user.type(screen.getByRole("textbox"), "SELECT 1");
    await user.click(screen.getByRole("button", { name: /clear/i }));

    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("[tag:data-preview][tag:sql] shows table hint with namespace and table name", async () => {
    renderPreview();

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("tab", { name: /query/i }));

    expect(screen.getByText(/iceberg/i)).toBeInTheDocument();
  });

  it("[tag:data-preview][tag:sql] Ctrl+Enter triggers query run", async () => {
    renderPreview();

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("tab", { name: /query/i }));

    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "SELECT 1");
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    await waitFor(() => {
      expect(mockQueryDataset).toHaveBeenCalledWith("SELECT 1");
    });
  });

  it("[tag:data-preview][tag:sql] shows results table after successful query", async () => {
    renderPreview();

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("tab", { name: /query/i }));
    await user.type(screen.getByRole("textbox"), "SELECT * FROM t");
    await user.click(screen.getByRole("button", { name: /run/i }));

    await waitFor(() => {
      expect(screen.getByText(/results/i)).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — tab switch (visual → query → visual)
// ---------------------------------------------------------------------------

describe("DatasetDetailDataPreview — tab switching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreviewDataset.mockResolvedValue(PREVIEW_RESPONSE);
  });

  it("[tag:data-preview][tag:tabs] switches back to visual tab", async () => {
    renderPreview();

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("tab", { name: /query/i }));
    await user.click(screen.getByRole("tab", { name: /visual/i }));

    // Should still render the preview table
    await waitFor(() => {
      expect(screen.getByTestId("preview-table")).toBeInTheDocument();
    });
  });

  it("[tag:data-preview][tag:tabs] does not call previewDataset again when switching back", async () => {
    renderPreview();

    // Wait for initial load
    await waitFor(() => expect(mockPreviewDataset).toHaveBeenCalledTimes(1));

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("tab", { name: /query/i }));
    await user.click(screen.getByRole("tab", { name: /visual/i }));

    // Should still only be called once
    expect(mockPreviewDataset).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — reload on snapshot change (regression: deleted file staying in
// preview after an edit+save, because the table was fetched once from a
// stale/older snapshot and never refetched)
// ---------------------------------------------------------------------------

describe("DatasetDetailDataPreview — snapshot changes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreviewDataset.mockResolvedValue(PREVIEW_RESPONSE);
  });

  it("[tag:data-preview][tag:snapshot] does not refetch when snapshotVersion is unchanged", async () => {
    const { rerender } = renderPreview({ snapshotVersion: 1 });

    await waitFor(() => expect(mockPreviewDataset).toHaveBeenCalledTimes(1));

    rerender(
      <DatasetDetailDataPreview
        dsetId="ds-1"
        namespace="ns"
        catalogTableName="my_table"
        isReady={true}
        snapshotVersion={1}
      />,
    );

    expect(mockPreviewDataset).toHaveBeenCalledTimes(1);
  });

  it("[tag:data-preview][tag:snapshot] refetches when snapshotVersion changes (e.g. after a delete+save re-import)", async () => {
    const { rerender } = renderPreview({ snapshotVersion: 1, snapshotId: "snap-a" });

    await waitFor(() => expect(mockPreviewDataset).toHaveBeenCalledTimes(1));

    // Simulate the backend finishing a re-import that dropped a file: the
    // dataset's latest_snapshot.version is bumped and the parent's polling
    // query propagates the new value down as a prop.
    rerender(
      <DatasetDetailDataPreview
        dsetId="ds-1"
        namespace="ns"
        catalogTableName="my_table"
        isReady={true}
        snapshotVersion={2}
        snapshotId="snap-b"
      />,
    );

    await waitFor(() => expect(mockPreviewDataset).toHaveBeenCalledTimes(2));
  });

  it("[tag:data-preview][tag:snapshot] refetches when snapshotId changes but version stays the same (table recreated on re-import)", async () => {
    const { rerender } = renderPreview({ snapshotVersion: 1, snapshotId: "snap-a", isReady: true });

    await waitFor(() => expect(mockPreviewDataset).toHaveBeenCalledTimes(1));

    rerender(
      <DatasetDetailDataPreview
        dsetId="ds-1"
        namespace="ns"
        catalogTableName="my_table"
        isReady={true}
        snapshotVersion={1}
        snapshotId="snap-b"
      />,
    );

    await waitFor(() => expect(mockPreviewDataset).toHaveBeenCalledTimes(2));
  });

  it("[tag:data-preview][tag:snapshot] reloads after re-import when isReady flips false then true again", async () => {
    const { rerender } = renderPreview({ snapshotVersion: 1, snapshotId: "snap-a", isReady: true });

    await waitFor(() => expect(mockPreviewDataset).toHaveBeenCalledTimes(1));

    rerender(
      <DatasetDetailDataPreview
        dsetId="ds-1"
        namespace="ns"
        catalogTableName="my_table"
        isReady={false}
        snapshotVersion={1}
        snapshotId="snap-a"
      />,
    );

    rerender(
      <DatasetDetailDataPreview
        dsetId="ds-1"
        namespace="ns"
        catalogTableName="my_table"
        isReady={true}
        snapshotVersion={1}
        snapshotId="snap-b"
      />,
    );

    await waitFor(() => expect(mockPreviewDataset).toHaveBeenCalledTimes(2));
  });

  it("[tag:data-preview][tag:snapshot] still fetches once on mount when snapshotVersion is not provided", async () => {
    renderPreview();

    await waitFor(() => expect(mockPreviewDataset).toHaveBeenCalledTimes(1));
  });
});
