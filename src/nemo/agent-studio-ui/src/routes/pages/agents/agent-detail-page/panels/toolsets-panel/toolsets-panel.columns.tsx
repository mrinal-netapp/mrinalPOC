import type { ColumnDef } from "@tanstack/react-table";
import { Link } from "react-router";

import { Typography } from "@/ui-lib/base-components/typography/typography";
import { ROUTES } from "@/routes/routes.consts";

import type { ToolsetRow } from "./toolsets-panel.types";
import { TOOLSETS_PANEL_STRINGS } from "./toolsets-panel.consts";
import { ToolsetStatusCell } from "./cells/toolset-status-cell";
import { ToolsetTypeCell } from "./cells/toolset-type-cell";

// Column set is intentionally narrow for the *agent details* surface:
// Name / Type / Status. The standalone Toolsets listing page renders
// the wider set (Associated agents / Labels / Actions); use the columns
// factory that lives next to that page when it is built. Mixing the
// two surfaces would force every consumer to toggle column visibility
// at runtime and obscure each surface's intent.
function createToolsetsColumns(): ColumnDef<ToolsetRow>[] {
  return [
    {
      accessorKey: "name",
      header: TOOLSETS_PANEL_STRINGS.COL_NAME,
      size: 220,
      minSize: 160,
      cell: ({ row }) => (
        <Link
          to={`/${ROUTES.TOOLSET}/${row.original.id}`}
          target="_blank"
          rel="noreferrer"
          className="agent-list-name-link"
        >
          <Typography
            Component="span"
            fontSize="fs14"
            boldness="regular"
            color="var(--text-button-primary)"
          >
            {row.original.name}
          </Typography>
        </Link>
      ),
    },
    {
      accessorKey: "type",
      header: TOOLSETS_PANEL_STRINGS.COL_TYPE,
      size: 140,
      minSize: 100,
      cell: ({ row }) => <ToolsetTypeCell type={row.original.type} />,
    },
    {
      accessorKey: "status",
      header: TOOLSETS_PANEL_STRINGS.COL_STATUS,
      size: 160,
      minSize: 120,
      cell: ({ row }) => <ToolsetStatusCell status={row.original.status} />,
    },
  ];
}

export { createToolsetsColumns };
