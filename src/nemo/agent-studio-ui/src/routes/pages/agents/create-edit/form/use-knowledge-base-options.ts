import { useMemo } from "react";

import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { useListProjectKnowledgeBasesQuery } from "@/routes/pages/agents/api/agents-config-api.slice";
import type {
  KnowledgeBaseStatus,
  KnowledgeBaseSummary,
} from "@/routes/pages/agents/api/agents-config.types";

import type {
  KnowledgeBaseAvailability,
  KnowledgeBaseOption,
} from "../configure-dialogs/configure-dialogs.types";

export type KnowledgeBaseOptions = {
  options: KnowledgeBaseOption[];
  isLoading: boolean;
  isError: boolean;
};

// Maps the config-service KB processing status onto the dialog's availability
// palette used by the status pill.
function toAvailability(status: KnowledgeBaseStatus): KnowledgeBaseAvailability {
  switch (status) {
    case "ready":
      return "available";
    case "in_progress":
      return "indexing";
    case "errored":
    case "deprecated":
      return "unavailable";
    default:
      return "unknown";
  }
}

function toKnowledgeBaseOption(kb: KnowledgeBaseSummary): KnowledgeBaseOption {
  return {
    id: kb.id,
    name: kb.name,
    status: toAvailability(kb.status),
    labels: kb.labels ?? [],
  };
}

/**
 * Loads the project's knowledge bases from config-service
 * (`GET /api/v1/projects/{projectId}/knowledgebases`) for the agent form's
 * "Add knowledge base" dialog. Deprecated KBs are excluded — they cannot be
 * newly assigned to an agent.
 */
export function useKnowledgeBaseOptions(): KnowledgeBaseOptions {
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data, isLoading, isError } = useListProjectKnowledgeBasesQuery(
    { projectId },
    { skip: !projectId },
  );

  const options = useMemo<KnowledgeBaseOption[]>(
    () =>
      (data ?? [])
        .filter((kb) => kb.status !== "deprecated")
        .map(toKnowledgeBaseOption),
    [data],
  );

  return { options, isLoading, isError: isError || !projectId };
}
