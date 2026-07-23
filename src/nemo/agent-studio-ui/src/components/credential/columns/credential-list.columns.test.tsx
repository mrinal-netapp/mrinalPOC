import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createCredentialListColumns, type CredentialTableRow } from "./credential-list.columns";

vi.mock("@/components/data-source/columns/cells/actions-cell", () => ({
  ActionsCell: ({
    row,
    menuItems,
  }: {
    row: CredentialTableRow;
    menuItems: unknown[];
  }) => (
    <div data-testid={`actions-${row.id}`}>
      {row.name}:{menuItems.length}
    </div>
  ),
}));

function renderCell(
  row: CredentialTableRow,
  columnIndex: number,
  actionMenuItems:
    | unknown[]
    | ((currentRow: CredentialTableRow) => unknown[]) = [],
): void {
  const columns = createCredentialListColumns({
    actionMenuItems: actionMenuItems as Parameters<typeof createCredentialListColumns>[0]["actionMenuItems"],
  });
  const cell = columns[columnIndex]?.cell;
  if (typeof cell !== "function") {
    throw new Error(`Column ${columnIndex} does not define a cell renderer.`);
  }

  render(
    <>{cell({ row: { original: row } } as never)}</>,
  );
}

const BASE_ROW: CredentialTableRow = {
  id: "cred-1",
  projectId: "proj-1",
  name: "Primary credential",
  description: "Credential description",
  provider: "azure_cloud",
  expiresAt: undefined,
  rotationVersion: 2,
  dependentsSummary: undefined,
  createdAt: "2026-01-10T00:00:00.000Z",
  updatedAt: "2026-01-11T00:00:00.000Z",
};

describe("createCredentialListColumns", () => {
  it("[tag:credential-columns] renders the basic text columns", () => {
    renderCell(BASE_ROW, 0);
    renderCell(BASE_ROW, 1);
    renderCell(BASE_ROW, 2);
    renderCell(BASE_ROW, 4);
    renderCell(BASE_ROW, 6);

    expect(screen.getByText("Primary credential")).toBeInTheDocument();
    expect(screen.getByText("azure_cloud")).toBeInTheDocument();
    expect(screen.getByText("Credential description")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("Jan 10, 2026")).toBeInTheDocument();
  });

  it("[tag:credential-columns] renders fallbacks for missing description, expiry, version, and dependents", () => {
    const row = {
      ...BASE_ROW,
      description: undefined,
      expiresAt: undefined,
      rotationVersion: undefined,
      dependentsSummary: { total: 0, byKind: {} },
    };

    renderCell(row, 2);
    renderCell(row, 3);
    renderCell(row, 4);
    renderCell(row, 5);

    expect(screen.getAllByText("—")).toHaveLength(4);
  });

  it("[tag:credential-columns] marks expired credentials", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-10T00:00:00.000Z"));

    renderCell(
      {
        ...BASE_ROW,
        expiresAt: "2026-01-09T00:00:00.000Z",
      },
      3,
    );

    expect(screen.getByText("Jan 9, 2026 (expired)")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("[tag:credential-columns] shows a near-expiry day count and a future formatted date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-10T00:00:00.000Z"));

    renderCell(
      {
        ...BASE_ROW,
        id: "cred-2",
        expiresAt: "2026-01-17T00:00:00.000Z",
      },
      3,
    );
    renderCell(
      {
        ...BASE_ROW,
        id: "cred-3",
        expiresAt: "2026-01-25T00:00:00.000Z",
      },
      3,
    );

    expect(screen.getByText("Jan 17, 2026 (7d)")).toBeInTheDocument();
    expect(screen.getByText("Jan 25, 2026")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("[tag:credential-columns] renders the used-by breakdown", () => {
    renderCell(
      {
        ...BASE_ROW,
        dependentsSummary: {
          total: 3,
          byKind: { agent: 2, pipeline: 1 },
        },
      },
      5,
    );

    expect(screen.getByText("3 (2 agent, 1 pipeline)")).toBeInTheDocument();
  });

  it("[tag:credential-columns] resolves actions from a function callback and from a static array", () => {
    const dynamicItems = vi.fn((row: CredentialTableRow) => [{ label: row.name }]);

    renderCell(BASE_ROW, 7, dynamicItems);
    renderCell({ ...BASE_ROW, id: "cred-4" }, 7, [{ label: "static" }]);

    expect(dynamicItems).toHaveBeenCalledWith(BASE_ROW);
    expect(screen.getByTestId("actions-cred-1")).toHaveTextContent("Primary credential:1");
    expect(screen.getByTestId("actions-cred-4")).toHaveTextContent("Primary credential:1");
  });
});
