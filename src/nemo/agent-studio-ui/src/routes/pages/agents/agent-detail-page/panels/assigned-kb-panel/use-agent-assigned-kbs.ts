import { useMemo } from "react";

import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import {
  useGetAgentQuery,
  useListProjectKnowledgeBasesQuery,
} from "@/routes/pages/agents/api/agents-config-api.slice";
import type {
  EntityRef,
  KnowledgeBaseStatus as ApiKnowledgeBaseStatus,
  KnowledgeBaseSummary,
} from "@/routes/pages/agents/api/agents-config.types";
import { isTeamAgentId } from "../../../utils/agents-api-mapper";
import type {
  AssignedKnowledgeBaseRow,
  KnowledgeBaseJobDetails,
  KnowledgeBaseStatus,
} from "./assigned-kb-panel.types";

interface UseAgentAssignedKbsResult {
  rows: AssignedKnowledgeBaseRow[];
  isLoading: boolean;
  isError: boolean;
}

// The agent payload's `associatedResources.knowledgeBases` is only a bare
// `{id, name}` reference, so the per-KB columns (status, job, indexed data,
// last sync, labels) are filled by joining the project KB list
// (`GET /knowledgebases`) on id. "Current version" has no backend source —
// KBs don't carry a version — so it stays 0.
// TODO(api): expose a KB version (or attach it to the agent enrichment).

// config-service KB status → panel status.
function mapKbStatus(status: ApiKnowledgeBaseStatus | undefined): KnowledgeBaseStatus {
  switch (status) {
    case "ready":
      return "Available";
    case "in_progress":
      return "Synchronizing";
    case "errored":
      return "Errored";
    case "deprecated":
      return "Deprecated";
    default:
      // Unknown / unresolved KB (e.g. missing from the project list) — show
      // it as available rather than alarming the user with a false error.
      return "Available";
  }
}

function mapKbJob(summary: KnowledgeBaseSummary | undefined): KnowledgeBaseJobDetails {
  if (!summary) return { state: "Ready", progress: 1 };
  if (summary.status === "ready") return { state: "Ready", progress: 1 };
  const pct = summary.progress?.percentage ?? 0;
  return { state: "Processing", progress: Math.min(1, Math.max(0, pct / 100)) };
}

function mapKnowledgeBase(
  ref: EntityRef,
  summary: KnowledgeBaseSummary | undefined,
): AssignedKnowledgeBaseRow {
  return {
    id: ref.id,
    // Prefer the agent enrichment's name (authoritative for the attachment),
    // fall back to the KB list name.
    name: ref.name || summary?.name || ref.id,
    status: mapKbStatus(summary?.status),
    job: mapKbJob(summary),
    indexed: {
      fileCount: summary?.stats?.fileCount ?? 0,
      vectorCount: summary?.stats?.vectorCount ?? 0,
    },
    lastSyncISO: summary?.lastSyncedAt ?? "",
    labels: summary?.labels ?? [],
  };
}

/**
 * Single source of truth for the knowledge bases attached to a given
 * agent.
 *
 * Both `AssignedKbPanel` (renders the rows) and `AgentDetailPage`
 * (counts the rows for the tab badge) consume this hook so the
 * visible count and the table contents can never drift apart.
 *
 * The set + order of attached KBs comes from `GET /agents/{id}` →
 * `associatedResources.knowledgeBases` (`EntityRef[]`). Each row's detail
 * columns are then resolved by joining `GET /knowledgebases` on id, since
 * the agent enrichment carries only `{id, name}`. The queries are skipped
 * for team agents (their details page mounts a different panel set) and for
 * empty ids so the page can mount before the URL param resolves.
 */
export function useAgentAssignedKbs(agentId: string): UseAgentAssignedKbsResult {
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const skip = !projectId || !agentId || isTeamAgentId(agentId);

  const { data, isLoading, isError } = useGetAgentQuery(
    { projectId, id: agentId },
    { skip },
  );

  const {
    data: kbList,
    isLoading: isKbListLoading,
    isError: isKbListError,
  } = useListProjectKnowledgeBasesQuery({ projectId }, { skip });

  const rows = useMemo<AssignedKnowledgeBaseRow[]>(() => {
    const refs = data?.associatedResources?.knowledgeBases;
    if (!refs) return [];
    const byId = new Map((kbList ?? []).map((kb) => [kb.id, kb]));
    return refs.map((ref) => mapKnowledgeBase(ref, byId.get(ref.id)));
  }, [data, kbList]);

  return {
    rows,
    isLoading: isLoading || isKbListLoading,
    isError: isError || isKbListError,
  };
}
