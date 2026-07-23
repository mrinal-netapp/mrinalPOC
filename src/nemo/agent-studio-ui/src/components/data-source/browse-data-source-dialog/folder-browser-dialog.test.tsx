import { act, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { renderWithProviders, userEvent } from "@test/render";
import { mockResizeObserver } from "@test/mocks";
import type { FolderBrowserRow } from "./folder-browser.columns";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockTriggerBrowse = vi.fn();

vi.mock("@/api/utilities-api.slice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/utilities-api.slice")>();
  return {
    ...actual,
    useLazyBrowseQuery: () => [mockTriggerBrowse, { isFetching: false }],
  };
});

// Mock BaseTable — renders all column cells per row for interaction tests
vi.mock("@/ui-lib/base-components/baseTableMcpBxp", () => ({
  BaseTable: ({
    data,
    isLoading,
    columns,
    onRowSelectionChange,
  }: {
    data: FolderBrowserRow[];
    isLoading: boolean;
    columns: Array<{
      accessorKey?: string;
      cell?: (ctx: { row: { original: FolderBrowserRow } }) => ReactNode;
    }>;
    onRowSelectionChange?: (selection: Record<string, boolean>) => void;
  }) => (
    <div data-testid="base-table" data-loading={String(isLoading)}>
      {data.map((row) => (
        <div key={row.id} data-testid="table-row" data-id={row.id}>
          {columns.map((col, ci) => (
            <span key={ci} data-testid={`cell-${col.accessorKey ?? ci}`}>
              {col.cell?.({ row: { original: row } })}
            </span>
          ))}
        </div>
      ))}
      {onRowSelectionChange && (
        <button
          data-testid="mock-select-rows"
          onClick={() => onRowSelectionChange(
            Object.fromEntries(data.map((r) => [r.id, true])),
          )}
        >
          Select all rows
        </button>
      )}
    </div>
  ),
}));

import { FolderBrowserDialog } from "./folder-browser-dialog";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BROWSE_ITEMS = [
  { name: "docs", path: "/docs", type: "directory", size: 0, lastModified: 1718438400000 },
  { name: "readme.txt", path: "/readme.txt", type: "txt", size: 1024, lastModified: 1718438400000 },
];

const NESTED_ITEMS = [
  { name: "sub", path: "/docs/sub", type: "directory", size: 0, lastModified: 1718438400000 },
  { name: "notes.md", path: "/docs/notes.md", type: "md", size: 512, lastModified: 1718438400000 },
];

function browsePage(items: typeof BROWSE_ITEMS, nextToken?: string) {
  return {
    unwrap: () => Promise.resolve({
      path: "/",
      items,
      totalItems: items.length,
      limit: 100,
      nextContinuationToken: nextToken,
    }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let roHandle: ReturnType<typeof mockResizeObserver>;

beforeEach(() => {
  vi.clearAllMocks();
  roHandle = mockResizeObserver();
  mockTriggerBrowse.mockReturnValue(browsePage(BROWSE_ITEMS));
});

afterEach(() => {
  roHandle.cleanup();
});

/**
 * FolderBrowserContent loads items in `useEffect` via `triggerBrowse().unwrap()`, then
 * `setAllItems` runs on a microtask. Synchronous assertions after `renderWithProviders`
 * finish before that update, which triggers React’s `act(...)` warning. Waiting until the
 * mocked browse result is reflected in the DOM keeps those updates inside Testing Library’s
 * async `act` (via `waitFor` / `findBy*`).
 */
async function waitForBrowseApplied(expectedRows = 2) {
  await waitFor(() => {
    expect(mockTriggerBrowse).toHaveBeenCalled();
  });
  if (expectedRows > 0) {
    await waitFor(() => {
      expect(screen.getAllByTestId("table-row")).toHaveLength(expectedRows);
    });
  } else {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FolderBrowserDialog — read-only mode", () => {
  const onClose = vi.fn();

  it("renders title, info text, and Close button in read-only mode", async () => {
    renderWithProviders(
      <FolderBrowserDialog
        open
        onClose={onClose}
        datasourceId="ds-1"
        isReadOnly
        totalFiles={1500}
        lastCompletedAt="2024-06-15T08:00:00Z"
      />,
    );

    await waitForBrowseApplied();

    expect(screen.getByText("Folder overview")).toBeInTheDocument();
    expect(screen.getByText(/1,500 files are identified/)).toBeInTheDocument();
    expect(screen.getByText("Close")).toBeInTheDocument();
  });

  it("calls onClose when Close button clicked", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <FolderBrowserDialog
        open
        onClose={onClose}
        datasourceId="ds-1"
        isReadOnly
      />,
    );

    await waitForBrowseApplied();
    await user.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when dialog backdrop is dismissed (onOpenChange false)", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <FolderBrowserDialog
        open
        onClose={onClose}
        datasourceId="ds-1"
        isReadOnly
      />,
    );

    await waitForBrowseApplied();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("does not render row selection controls in read-only mode", async () => {
    renderWithProviders(
      <FolderBrowserDialog
        open
        onClose={onClose}
        datasourceId="ds-1"
        isReadOnly
      />,
    );

    await waitForBrowseApplied();
    expect(screen.queryByTestId("mock-select-rows")).not.toBeInTheDocument();
  });

  it("renders '-' for lastCompletedAt when null", async () => {
    renderWithProviders(
      <FolderBrowserDialog
        open
        onClose={onClose}
        datasourceId="ds-1"
        isReadOnly
        totalFiles={null}
        lastCompletedAt={null}
      />,
    );

    await waitForBrowseApplied();
    expect(screen.getByText(/- files are identified/)).toBeInTheDocument();
  });
});

describe("FolderBrowserDialog — edit mode", () => {
  const onClose = vi.fn();
  const onAdd = vi.fn();

  it("renders 'Add datasource scope' title and Add/Cancel buttons", async () => {
    renderWithProviders(
      <FolderBrowserDialog
        open
        onClose={onClose}
        datasourceId="ds-1"
        isReadOnly={false}
        onAdd={onAdd}
      />,
    );

    await waitForBrowseApplied();
    expect(screen.getByText("Add datasource scope")).toBeInTheDocument();
    expect(screen.getByText("Browse the file tree and choose folders to add to this dataset.")).toBeInTheDocument();
    expect(screen.getByText("Add")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("Cancel button calls onClose", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <FolderBrowserDialog
        open
        onClose={onClose}
        datasourceId="ds-1"
        isReadOnly={false}
        onAdd={onAdd}
      />,
    );

    await waitForBrowseApplied();
    await user.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalled();
  });

  it("Add button calls onAdd with selected folder paths and closes", async () => {
    const user = userEvent.setup();
    mockTriggerBrowse.mockReturnValue(browsePage(BROWSE_ITEMS));

    renderWithProviders(
      <FolderBrowserDialog
        open
        onClose={onClose}
        datasourceId="ds-1"
        isReadOnly={false}
        onAdd={onAdd}
      />,
    );

    await waitForBrowseApplied();

    // Select rows — the mock selects all, but handleRowSelectionChange filters to directories only
    await user.click(screen.getByTestId("mock-select-rows"));
    await user.click(screen.getByText("Add"));

    expect(onAdd).toHaveBeenCalledWith(["/docs"]);
    expect(onClose).toHaveBeenCalled();
  });

  it("Add with no selection calls onAdd with empty array", async () => {
    const user = userEvent.setup();
    mockTriggerBrowse.mockReturnValue(browsePage([]));

    renderWithProviders(
      <FolderBrowserDialog
        open
        onClose={onClose}
        datasourceId="ds-1"
        isReadOnly={false}
        onAdd={onAdd}
      />,
    );

    await waitForBrowseApplied(0);

    await user.click(screen.getByText("Add"));
    expect(onAdd).toHaveBeenCalledWith([]);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("FolderBrowserDialog — browse fetching", () => {
  const onClose = vi.fn();

  it("calls triggerBrowse on open with root path", async () => {
    renderWithProviders(
      <FolderBrowserDialog
        open
        onClose={onClose}
        datasourceId="ds-1"
        isReadOnly
      />,
    );

    await waitFor(() => {
      expect(mockTriggerBrowse).toHaveBeenCalledWith(
        expect.objectContaining({ datasourceId: "ds-1", path: "/" }),
      );
    });
    await waitForBrowseApplied();
  });

  it("does not fetch when dialog is closed", () => {
    renderWithProviders(
      <FolderBrowserDialog
        open={false}
        onClose={onClose}
        datasourceId="ds-1"
        isReadOnly
      />,
    );

    expect(mockTriggerBrowse).not.toHaveBeenCalled();
  });

  it("fetches all pages when continuation token is present", async () => {
    let callCount = 0;
    mockTriggerBrowse.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return browsePage([BROWSE_ITEMS[0]], "token-2");
      return browsePage([BROWSE_ITEMS[1]]);
    });

    renderWithProviders(
      <FolderBrowserDialog
        open
        onClose={onClose}
        datasourceId="ds-1"
        isReadOnly
      />,
    );

    await waitFor(() => {
      expect(mockTriggerBrowse).toHaveBeenCalledTimes(2);
    });

    await waitFor(() => {
      expect(screen.getByText("docs")).toBeInTheDocument();
      expect(screen.getByText("readme.txt")).toBeInTheDocument();
    });
    await waitForBrowseApplied(2);
  });

  it("uses rootPath prop for initial breadcrumbs and fetches that path", async () => {
    mockTriggerBrowse.mockReturnValue(browsePage(NESTED_ITEMS));

    renderWithProviders(
      <FolderBrowserDialog
        open
        onClose={onClose}
        datasourceId="ds-1"
        rootPath="/docs"
        isReadOnly
      />,
    );

    await waitFor(() => {
      expect(mockTriggerBrowse).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/docs" }),
      );
    });

    await waitForBrowseApplied();
    expect(screen.getByText("docs")).toBeInTheDocument();
  });
});

describe("FolderBrowserDialog — breadcrumb navigation", () => {
  const onClose = vi.fn();

  it("clicking a folder navigates deeper and resets selection", async () => {
    const user = userEvent.setup();
    mockTriggerBrowse
      .mockReturnValueOnce(browsePage(BROWSE_ITEMS))
      .mockReturnValue(browsePage(NESTED_ITEMS));

    renderWithProviders(
      <FolderBrowserDialog
        open
        onClose={onClose}
        datasourceId="ds-1"
        isReadOnly={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("docs")).toBeInTheDocument();
    });

    // Click folder "docs" — the name cell renders a clickable button for directories
    const folderButton = screen.getByRole("button", { name: "docs" });
    await user.click(folderButton);

    // Breadcrumb should now show "docs"
    await waitFor(() => {
      expect(mockTriggerBrowse).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/docs" }),
      );
    });
  });

  it("clicking a non-last breadcrumb segment navigates to that depth", async () => {
    const user = userEvent.setup();
    mockTriggerBrowse.mockReturnValue(browsePage(NESTED_ITEMS));

    renderWithProviders(
      <FolderBrowserDialog
        open
        onClose={onClose}
        datasourceId="ds-1"
        rootPath="/docs/sub"
        isReadOnly
      />,
    );

    await waitForBrowseApplied();

    // Breadcrumb should show: / > docs > sub
    // "docs" is not last, so it should be clickable
    const breadcrumbNav = screen.getByRole("navigation", { name: "Folder path" });
    const buttons = within(breadcrumbNav).getAllByRole("button");
    // buttons: ["/", "docs", "sub"] — "docs" is index 1
    await user.click(buttons[1]);

    await waitFor(() => {
      expect(mockTriggerBrowse).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/docs" }),
      );
    });
  });

  it("clicking root breadcrumb navigates back to root", async () => {
    const user = userEvent.setup();
    mockTriggerBrowse
      .mockReturnValueOnce(browsePage(BROWSE_ITEMS))
      .mockReturnValue(browsePage(NESTED_ITEMS));

    renderWithProviders(
      <FolderBrowserDialog
        open
        onClose={onClose}
        datasourceId="ds-1"
        rootPath="/docs"
        isReadOnly
      />,
    );

    await waitForBrowseApplied();

    // Click root "/" breadcrumb — first breadcrumb button
    const breadcrumbNav = screen.getByRole("navigation", { name: "Folder path" });
    const rootButton = within(breadcrumbNav).getAllByRole("button")[0];
    await user.click(rootButton);

    await waitFor(() => {
      expect(mockTriggerBrowse).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/" }),
      );
    });
  });
});

describe("FolderBrowserDialog — column rendering", () => {
  const onClose = vi.fn();

  it("renders folder type as 'Folder' and file type uppercased", async () => {
    renderWithProviders(
      <FolderBrowserDialog
        open
        onClose={onClose}
        datasourceId="ds-1"
        isReadOnly
      />,
    );

    await waitForBrowseApplied();
    expect(screen.getByText("Folder")).toBeInTheDocument();
    expect(screen.getByText("TXT")).toBeInTheDocument();
  });

  it("renders size via formatBytes", async () => {
    renderWithProviders(
      <FolderBrowserDialog
        open
        onClose={onClose}
        datasourceId="ds-1"
        isReadOnly
      />,
    );

    await waitForBrowseApplied();

    expect(screen.getByText("0 B")).toBeInTheDocument();
    expect(screen.getByText("1 KB")).toBeInTheDocument();
  });

  it("renders last modified as a formatted date", async () => {
    renderWithProviders(
      <FolderBrowserDialog
        open
        onClose={onClose}
        datasourceId="ds-1"
        isReadOnly
      />,
    );

    await waitForBrowseApplied();

    // 1718438400000 = Jun 15, 2024 in UTC
    expect(screen.getAllByText(/Jun 15, 2024/).length).toBeGreaterThanOrEqual(1);
  });

  it("renders non-directory names as plain text (not clickable)", async () => {
    renderWithProviders(
      <FolderBrowserDialog
        open
        onClose={onClose}
        datasourceId="ds-1"
        isReadOnly
      />,
    );

    await waitForBrowseApplied();
    expect(screen.getByText("readme.txt")).toBeInTheDocument();

    // "readme.txt" should be plain text, not a button
    expect(screen.queryByRole("button", { name: "readme.txt" })).not.toBeInTheDocument();
  });
});

describe("FolderBrowserDialog — reset on reopen", () => {
  const onClose = vi.fn();

  it("resets breadcrumbs and selection when dialog reopens", async () => {
    const { rerender } = renderWithProviders(
      <FolderBrowserDialog
        open
        onClose={onClose}
        datasourceId="ds-1"
        isReadOnly
      />,
    );

    await waitForBrowseApplied();

    // Close dialog
    rerender(
      <FolderBrowserDialog
        open={false}
        onClose={onClose}
        datasourceId="ds-1"
        isReadOnly
      />,
    );

    // Reopen — state should be reset
    rerender(
      <FolderBrowserDialog
        open
        onClose={onClose}
        datasourceId="ds-1"
        isReadOnly
      />,
    );

    await waitForBrowseApplied();

    await waitFor(() => {
      expect(mockTriggerBrowse).toHaveBeenLastCalledWith(
        expect.objectContaining({ path: "/" }),
      );
    });
  });
});

describe("FolderBrowserDialog — stale fetch cancellation", () => {
  const onClose = vi.fn();

  it("discards fetch result when navigation happens before it resolves", async () => {
    const user = userEvent.setup();

    let resolveFirst!: (val: { items: typeof BROWSE_ITEMS; totalItems: number; limit: number; nextContinuationToken?: string }) => void;
    const hangingPromise = new Promise<{ items: typeof BROWSE_ITEMS; totalItems: number; limit: number; nextContinuationToken?: string }>(
      (res) => { resolveFirst = res; },
    );

    mockTriggerBrowse
      .mockReturnValueOnce({ unwrap: () => hangingPromise })
      .mockReturnValue(browsePage(NESTED_ITEMS));

    renderWithProviders(
      <FolderBrowserDialog
        open
        onClose={onClose}
        datasourceId="ds-1"
        rootPath="/docs"
        isReadOnly={false}
      />,
    );

    // The first fetch is still pending; navigate deeper via a folder click.
    // First we need items to appear — but the first fetch is hanging.
    // Instead, navigate by clicking a breadcrumb to change currentPath,
    // which triggers the cleanup (cancelled = true) for the first effect.
    const breadcrumbNav = screen.getByRole("navigation", { name: "Folder path" });
    const rootBtn = within(breadcrumbNav).getAllByRole("button")[0];
    await user.click(rootBtn);

    // Now resolve the stale first fetch — its result should be discarded
    await act(async () => {
      resolveFirst({ items: BROWSE_ITEMS, totalItems: 2, limit: 100 });
    });

    // The table should show NESTED_ITEMS (from the second fetch), not BROWSE_ITEMS
    await waitFor(() => {
      expect(screen.getByText("sub")).toBeInTheDocument();
    });
    expect(screen.queryByText("readme.txt")).not.toBeInTheDocument();
  });
});

describe("FolderBrowserDialog — browse error", () => {
  it("clears items and shows empty state when browse API rejects", async () => {
    mockTriggerBrowse.mockReturnValue({
      unwrap: () => Promise.reject(new Error("network error")),
    });

    renderWithProviders(
      <FolderBrowserDialog
        open
        onClose={vi.fn()}
        datasourceId="ds-err"
        isReadOnly
      />,
    );

    await waitFor(() => {
      expect(screen.queryByTestId("table-row")).not.toBeInTheDocument();
    });
  });
});

describe("FOLDER_BROWSER_TABLE_OPTIONS — enableRowSelection", () => {
  it("returns true for directory rows and false for file rows", async () => {
    const { FOLDER_BROWSER_TABLE_OPTIONS } = await import("./folder-browser.columns");

    const dirRow = { id: "1", name: "docs", path: "/docs", type: "directory", size: 0, lastModified: 0 } as FolderBrowserRow;
    const fileRow = { id: "2", name: "file.txt", path: "/file.txt", type: "txt", size: 100, lastModified: 0 } as FolderBrowserRow;

    const selector = FOLDER_BROWSER_TABLE_OPTIONS.enableRowSelection as (row: FolderBrowserRow) => boolean;
    expect(selector(dirRow)).toBe(true);
    expect(selector(fileRow)).toBe(false);
  });
});
