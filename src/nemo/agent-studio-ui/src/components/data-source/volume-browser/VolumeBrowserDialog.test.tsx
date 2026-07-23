import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockVolumeBrowse = vi.fn();

vi.mock("@/api/workflow-api", () => ({
  volumeBrowse: (...args: unknown[]) => mockVolumeBrowse(...args),
}));

vi.mock("@/components/data-source/utils/data-source.utils", () => ({
  formatBytes: (value: number) => `${value} bytes`,
}));

vi.mock("@/ui-lib/base-components/dialog/dialog", () => ({
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
  }) => (
    <div data-testid="dialog" data-open={String(open)}>
      <button type="button" onClick={() => onOpenChange(false)}>dismiss-dialog</button>
      {children}
    </div>
  ),
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/ui-lib/base-components/card/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/ui-lib/base-components/card/card.header", () => ({
  CardHeader: ({
    title,
    actions,
  }: {
    title: string;
    actions?: ReactNode[];
  }) => (
    <div>
      <h1>{title}</h1>
      {actions}
    </div>
  ),
}));
vi.mock("@/ui-lib/base-components/card/card.content", () => ({
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/ui-lib/base-components/card/card.block", () => ({
  CardBlock: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/ui-lib/base-components/card/card.footer", () => ({
  CardFooter: ({
    actions,
  }: {
    actions: Array<{ label: string; onClick: () => void }>;
  }) => (
    <div>
      {actions.map((action) => (
        <button key={action.label} type="button" onClick={action.onClick}>
          {action.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("@/ui-lib/base-components/typography/typography", () => ({
  Typography: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/ui-lib/base-components/baseTableMcpBxp", () => ({
  BaseTable: ({
    data,
    columns,
    isLoading,
    isError,
    onRowSelectionChange,
    options,
  }: {
    data: Array<{ id: string }>;
    columns: Array<{ cell?: (arg: unknown) => ReactNode }>;
    isLoading: boolean;
    isError: boolean;
    onRowSelectionChange?: (selection: Record<string, boolean>) => void;
    options?: { enableRowMultiSelection?: boolean; enablePagination?: boolean; enableTableTopBar?: boolean };
  }) => (
    <div
      data-testid="base-table"
      data-loading={String(isLoading)}
      data-error={String(isError)}
      data-multi={String(Boolean(options?.enableRowMultiSelection))}
      data-pagination={String(Boolean(options?.enablePagination))}
      data-topbar={String(Boolean(options?.enableTableTopBar))}
    >
      <button
        type="button"
        onClick={() => onRowSelectionChange?.(Object.fromEntries(data.map((row) => [row.id, true])))}
      >
        select-all
      </button>
      {data.map((row) => (
        <div key={row.id} data-testid={`row-${row.id}`}>
          {columns.map((column, index) => (
            <div key={`${row.id}-${index}`}>
              {typeof column.cell === "function"
                ? column.cell({ row: { original: row } } as never)
                : null}
            </div>
          ))}
          <button type="button" onClick={() => onRowSelectionChange?.({ [row.id]: true })}>
            {`select-${row.id}`}
          </button>
        </div>
      ))}
    </div>
  ),
}));

import { VolumeBrowser, VolumeBrowserDialog } from "./VolumeBrowserDialog";

describe("VolumeBrowserDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("[tag:volume-browser] loads the root path in read-only mode and renders file details", async () => {
    const onOpenChange = vi.fn();
    mockVolumeBrowse.mockResolvedValue({
      entries: [
        { name: "folder-a", path: "folder-a", type: "directory", size: 0, lastModified: "" },
        { name: "file-a.txt", path: "file-a.txt", type: "file", size: 512, lastModified: "2026-01-02T03:04:05Z" },
      ],
    });

    render(
      <VolumeBrowserDialog
        open
        onOpenChange={onOpenChange}
        projectId="proj-1"
        volumeId="volume-1"
        volumeName="Volume"
        initialPath="/"
      />,
    );

    await waitFor(() => {
      expect(mockVolumeBrowse).toHaveBeenCalledWith("proj-1", "volume-1", "");
    });
    expect(screen.getByRole("heading", { name: "Data Source Overview" })).toBeInTheDocument();
    expect(screen.getByText("Folder")).toBeInTheDocument();
    expect(screen.getByText("File")).toBeInTheDocument();
    expect(screen.getByText("512 bytes")).toBeInTheDocument();
    expect(screen.getAllByText("–").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "folder-a" }));
    await waitFor(() => {
      expect(mockVolumeBrowse).toHaveBeenLastCalledWith("proj-1", "volume-1", "folder-a");
    });

    fireEvent.click(screen.getByText("dismiss-dialog"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("[tag:volume-browser] filters row selection to directories and adds the selected paths", async () => {
    const onAdd = vi.fn();
    const onOpenChange = vi.fn();
    mockVolumeBrowse.mockResolvedValue({
      entries: [
        { name: "folder-a", path: "folder-a", type: "directory", size: 0, lastModified: "" },
        { name: "file-a.txt", path: "file-a.txt", type: "file", size: 512, lastModified: "" },
      ],
    });

    render(
      <VolumeBrowserDialog
        open
        onOpenChange={onOpenChange}
        projectId="proj-1"
        volumeId="volume-1"
        volumeName="Volume"
        onAdd={onAdd}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Add datasource scope" })).toBeInTheDocument();
    });
    expect(screen.getByTestId("base-table")).toHaveAttribute("data-multi", "true");

    await userEvent.click(screen.getByRole("button", { name: "select-all" }));
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onAdd).toHaveBeenCalledWith(["folder-a"]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("[tag:volume-browser] shows truncation and browse warnings from a successful response", async () => {
    mockVolumeBrowse.mockResolvedValue({
      entries: [{ name: "folder-a", path: "folder-a", type: "directory", size: 0, lastModified: "" }],
      truncated: true,
      error: { code: "NOT_READY", message: "Not ready" },
    });

    render(
      <VolumeBrowserDialog
        open
        onOpenChange={vi.fn()}
        projectId="proj-1"
        volumeId="volume-1"
        volumeName="Volume"
      />,
    );

    expect(await screen.findByText("This directory isn't available yet.")).toBeInTheDocument();
    expect(
      screen.getByText("Too many items — showing first 1 entries. Navigate into a subfolder for a full listing."),
    ).toBeInTheDocument();
  });

  it("[tag:volume-browser] marks the table errored when loading the directory fails", async () => {
    mockVolumeBrowse.mockRejectedValue(new Error("boom"));

    render(
      <VolumeBrowserDialog
        open
        onOpenChange={vi.fn()}
        projectId="proj-1"
        volumeId="volume-1"
        volumeName="Volume"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("base-table")).toHaveAttribute("data-error", "true");
    });
  });

  it("[tag:volume-browser] does not render the inner content while closed", () => {
    render(
      <VolumeBrowserDialog
        open={false}
        onOpenChange={vi.fn()}
        projectId="proj-1"
        volumeId="volume-1"
        volumeName="Volume"
      />,
    );

    expect(screen.queryByRole("heading", { name: "Data Source Overview" })).not.toBeInTheDocument();
  });

  it("[tag:volume-browser] refreshes and navigates back to the root breadcrumb", async () => {
    mockVolumeBrowse
      .mockResolvedValueOnce({
        entries: [{ name: "folder-a", path: "folder-a", type: "directory", size: 0, lastModified: "" }],
      })
      .mockResolvedValueOnce({
        entries: [{ name: "nested", path: "folder-a/nested", type: "directory", size: 0, lastModified: "" }],
      })
      .mockResolvedValueOnce({
        entries: [{ name: "nested", path: "folder-a/nested", type: "directory", size: 0, lastModified: "" }],
      })
      .mockResolvedValueOnce({
        entries: [{ name: "folder-a", path: "folder-a", type: "directory", size: 0, lastModified: "" }],
      });

    render(
      <VolumeBrowserDialog
        open
        onOpenChange={vi.fn()}
        projectId="proj-1"
        volumeId="volume-1"
        volumeName="Volume"
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "folder-a" }));
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await userEvent.click(screen.getByRole("button", { name: "/" }));

    await waitFor(() => {
      expect(mockVolumeBrowse).toHaveBeenNthCalledWith(3, "proj-1", "volume-1", "folder-a");
      expect(mockVolumeBrowse).toHaveBeenNthCalledWith(4, "proj-1", "volume-1", "");
    });
  });

  it("[tag:volume-browser] embedded mode enables pagination and hides dialog footer", async () => {
    mockVolumeBrowse.mockResolvedValue({
      entries: [{ name: "file-a.txt", path: "file-a.txt", type: "file", size: 512, lastModified: "" }],
    });

    render(
      <VolumeBrowser
        embedded
        projectId="proj-1"
        volumeId="volume-1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("base-table")).toHaveAttribute("data-pagination", "true");
    });
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Data Source Overview" })).not.toBeInTheDocument();
  });

  it("[tag:volume-browser] embedded mode applies client filters to loaded rows", async () => {
    mockVolumeBrowse.mockResolvedValue({
      entries: [
        { name: "file-a.txt", path: "file-a.txt", type: "file", size: 512, lastModified: "" },
        { name: "folder-b", path: "folder-b", type: "directory", size: 0, lastModified: "" },
      ],
    });

    render(
      <VolumeBrowser
        embedded
        projectId="proj-1"
        volumeId="volume-1"
        clientFilters={[{ column: "Type", op: "=", value: "File" }]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("row-file-a.txt")).toBeInTheDocument();
      expect(screen.queryByTestId("row-folder-b")).not.toBeInTheDocument();
    });
  });

  it("[tag:volume-browser] treats zero-byte files as size 0 for filtering", async () => {
    mockVolumeBrowse.mockResolvedValue({
      entries: [
        { name: "empty.txt", path: "empty.txt", type: "file", size: 0, lastModified: "" },
        { name: "folder-b", path: "folder-b", type: "directory", size: 0, lastModified: "" },
      ],
    });

    render(
      <VolumeBrowser
        embedded
        projectId="proj-1"
        volumeId="volume-1"
        clientFilters={[{ column: "Size", op: "=", value: "0" }]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("row-empty.txt")).toBeInTheDocument();
      expect(screen.queryByTestId("row-folder-b")).not.toBeInTheDocument();
    });
  });
});
