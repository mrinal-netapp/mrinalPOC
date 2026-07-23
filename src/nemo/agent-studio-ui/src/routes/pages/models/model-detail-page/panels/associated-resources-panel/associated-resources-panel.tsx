import { type ReactElement } from "react"
import { Link } from "react-router"
import type { ColumnDef } from "@tanstack/react-table"

import { Typography } from "@/ui-lib/base-components/typography/typography"
import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp"
import { agentPaths } from "@/routes/pages/agents/agents.consts"
import { kbPaths } from "@/routes/pages/knowledge-base/knowledge-base.consts"
import { evalPaths } from "@/routes/pages/evaluations/evaluations.consts"
import {
  formatDependentKind,
  formatDependentRelation,
} from "../../model-dependents.utils"
import type { ModelDependentResource } from "../../model-detail-page.types"
import type { AssociatedResourcesPanelProps } from "./associated-resources-panel.types"

/**
 * Resolve the client-side detail-page path for a dependent resource from its
 * `kind`. Agents and agent teams share the `/agents/:id` route. Kinds without
 * a dedicated detail page (or a missing id) return `undefined`, so the caller
 * renders plain text instead of a dead link.
 */
function resolveDependentHref(kind: string, id: string): string | undefined {
  if (!id) return undefined
  switch (kind) {
    case "agent":
    case "agent_team":
      return agentPaths.detail(id)
    case "knowledge_base":
      return kbPaths.detail(id)
    case "evaluation":
      return evalPaths.detail(id)
    default:
      return undefined
  }
}

const DEPENDENT_COLUMNS: ColumnDef<ModelDependentResource>[] = [
  {
    accessorKey: "kind",
    header: "Type",
    size: 160,
    cell: ({ row }) => (
      <Typography fontSize="fs14" Component="span">
        {formatDependentKind(row.getValue("kind") as string)}
      </Typography>
    ),
  },
  {
    accessorKey: "name",
    header: "Name",
    size: 240,
    cell: ({ row }) => {
      const { kind, id, name } = row.original
      const href = resolveDependentHref(kind, id)
      // Link to the resource's own detail page when the kind has one, falling
      // back to plain text for kinds we can't route to. The name is rendered
      // directly inside the anchor (not wrapped in Typography) so the link's
      // color + underline apply to the text — Typography renders an
      // inline-block span with its own color that would otherwise mask them.
      return href ? (
        <Link to={href} className="model-associated__link">
          {name}
        </Link>
      ) : (
        <Typography fontSize="fs14" Component="span">
          {name}
        </Typography>
      )
    },
  },
  {
    accessorKey: "relation",
    header: "Relation",
    size: 200,
    cell: ({ row }) => (
      <Typography fontSize="fs14" Component="span">
        {formatDependentRelation(row.getValue("relation") as string)}
      </Typography>
    ),
  },
]

function AssociatedResourcesPanel({ dependents }: AssociatedResourcesPanelProps): ReactElement {
  return (
    <div className="model-associated" data-testid="associated-resources-panel">
      <Typography fontSize="fs16" boldness="semibold" Component="h2" className="model-associated__heading">
        Associated resources ({dependents.length})
      </Typography>
      <BaseTable
        data={dependents}
        columns={DEPENDENT_COLUMNS}
        options={{ enableColumnSorting: true }}
      />
    </div>
  )
}

export { AssociatedResourcesPanel }
