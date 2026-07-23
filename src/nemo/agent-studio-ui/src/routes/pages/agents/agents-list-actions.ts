import type { NavigateFunction } from "react-router";

import type {
  AgentTableRow,
  ActionMenuItem,
} from "./columns/agents-list.columns";
import { AGENTS_LIST_STRINGS, LOCK_AGENT_DEPLOY, DEPLOY_LOCKED_CLASS, isDeployActivationLocked, agentsPaths } from "./agents.consts";

export type DeleteTarget = {
  id: string;
  name: string;
};

export type ActionMenuDeps = {
  navigate: NavigateFunction;
  isDeprecated: (id: string) => boolean;
  // deprecate: (id: string) => void;
  // undeprecate: (id: string) => void;
  onRequestDelete: (target: DeleteTarget) => void;
  // Kind-specific deploy handler supplied by each list (single → agent status
  // mutation, team → team status mutation). Fires the real backend call and
  // owns its own success/error toasts so the menu factory stays kind-agnostic.
  deploy: (row: AgentTableRow) => void;
  // Kind-specific draft handler — mirrors deploy but transitions status to draft.
  draft: (row: AgentTableRow) => void;
};

/**
 * Builds the row kebab-menu for the single- and team-agent list tables.
 *
 * The two lists share identical row-action semantics, so the menu factory
 * lives in its own module (rather than inside either list component) to keep
 * the logic DRY and to keep the list `.tsx` files fast-refresh friendly
 * (component-only exports).
 */
export function buildActionMenu(
  row: AgentTableRow,
  {
    navigate,
    isDeprecated,
    // deprecate,
    // undeprecate,
    onRequestDelete,
    deploy,
    draft,
  }: ActionMenuDeps,
): ActionMenuItem<AgentTableRow>[] {
  const deleteBlockedByDependency = (row.teamDependencyCount ?? 0) > 0;

  // Deprecated rows show a minimal, view-only menu so the row stays
  // discoverable but cannot be edited / re-deployed / deleted until
  // the user explicitly undeprecates it.
  if (isDeprecated(row.id)) {
    return [
      { label: AGENTS_LIST_STRINGS.ACTION_VIEW_DETAILS, onClick: () => navigate(agentsPaths.detail(row.id)) },
      // { label: AGENTS_LIST_STRINGS.ACTION_UNDEPRECATE, onClick: () => undeprecate(row.id) },
      { label: AGENTS_LIST_STRINGS.ACTION_DRAFT, isDisabled: true, onClick: () => undefined },
      { label: AGENTS_LIST_STRINGS.ACTION_EDIT, isDisabled: true, onClick: () => undefined },
      { label: AGENTS_LIST_STRINGS.ACTION_DELETE, isDisabled: true, onClick: () => undefined },
    ];
  }

  const isDeployed = row.deploymentStatus === "deployed";

  if (isDeployed) {
    return [
      { label: AGENTS_LIST_STRINGS.ACTION_VIEW_DETAILS, onClick: () => navigate(agentsPaths.detail(row.id)) },
      { label: AGENTS_LIST_STRINGS.ACTION_DRAFT, onClick: () => draft(row) },
      // { label: AGENTS_LIST_STRINGS.ACTION_DEPRECATE, onClick: () => deprecate(row.id) },
      // Editing a deployed agent requires drafting it first — disabled intentionally.
      { label: AGENTS_LIST_STRINGS.ACTION_EDIT, isDisabled: true, onClick: () => undefined },
      {
        label: AGENTS_LIST_STRINGS.ACTION_DELETE,
        isDisabled: deleteBlockedByDependency,
        onClick: () => onRequestDelete({ id: row.id, name: row.name }),
      },
    ];
  }

  return [
    { label: AGENTS_LIST_STRINGS.ACTION_VIEW_DETAILS, onClick: () => navigate(agentsPaths.detail(row.id)) },
    {
      label: AGENTS_LIST_STRINGS.ACTION_DEPLOY,
      ...(LOCK_AGENT_DEPLOY
        ? { className: DEPLOY_LOCKED_CLASS, ariaDisabled: true }
        : { isDisabled: row.hasBlockingRequirements ?? false }),
      // True lock: the JS guard makes keyboard/programmatic activation a no-op
      // while the --locked marker is present, so `onClick` stays wired (QA can
      // unlock in devtools) without Deploy actually firing. The devtools-unlock
      // path only lifts the lock — it must still honour the normal requirements
      // gate, so blocking requirements short-circuit the deploy independently.
      onClick: (row, event) => {
        if (isDeployActivationLocked(event?.currentTarget ?? null)) return;
        if (row.hasBlockingRequirements) return;
        deploy(row);
      },
    },
    { label: AGENTS_LIST_STRINGS.ACTION_EDIT, onClick: () => navigate(agentsPaths.edit(row.id), { state: { returnTo: agentsPaths.root } }) },
    {
      label: AGENTS_LIST_STRINGS.ACTION_DELETE,
      // Block deletes only when this row is referenced by team membership.
      isDisabled: deleteBlockedByDependency,
      onClick: () => onRequestDelete({ id: row.id, name: row.name }),
    },
  ];
}
