import type { ColumnDef } from "@tanstack/react-table";
import { Link } from "react-router";

import { Typography } from "@/ui-lib/base-components/typography/typography";
import { formatDateTimeFull } from "@/components/data-source/utils/data-source.utils";
import { ROUTES } from "@/routes/routes.consts";

import type { AssignedKnowledgeBaseRow } from "./assigned-kb-panel.types";
import { ASSIGNED_KB_PANEL_STRINGS } from "./assigned-kb-panel.consts";
import { KbStatusCell } from "./cells/kb-status-cell";

// Column set is intentionally narrow for the *agent details* surface:
// Name / Status / Last synchronization. The standalone Knowledge bases
// listing page renders the wider set (Job details / Indexed data / Labels /
// Actions); use its own columns factory there.
function createAssignedKbColumns(): ColumnDef<AssignedKnowledgeBaseRow>[] {
  return [
    {
      accessorKey: "name",
      header: ASSIGNED_KB_PANEL_STRINGS.COL_NAME,
      size: 260,
      minSize: 180,
      cell: ({ row }) => (
        <Link
          to={`/${ROUTES.KNOWLEDGE_BASES}/${row.original.id}`}
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
      accessorKey: "status",
      header: ASSIGNED_KB_PANEL_STRINGS.COL_STATUS,
      size: 180,
      minSize: 140,
      cell: ({ row }) => <KbStatusCell status={row.original.status} />,
    },
    {
      id: "last_sync",
      header: ASSIGNED_KB_PANEL_STRINGS.COL_LAST_SYNC,
      size: 240,
      minSize: 200,
      accessorFn: (row) => row.lastSyncISO,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {row.original.lastSyncISO ? formatDateTimeFull(row.original.lastSyncISO) : "—"}
        </Typography>
      ),
    },
  ];
}

export { createAssignedKbColumns };
