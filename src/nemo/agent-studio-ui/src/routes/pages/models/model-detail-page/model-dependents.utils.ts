import type { DependentsPage } from "@/routes/pages/agents/api/agents-config.types";

const KIND_LABELS: Record<string, string> = {
  agent: "Agent",
  agent_team: "Agent team",
  evaluation: "Evaluation",
  knowledge_base: "Knowledge base",
};

const RELATION_LABELS: Record<string, string> = {
  uses_model: "Uses model",
  uses_team_model: "Team model",
  uses_judge_model: "Judge model",
  uses_embedding_model: "Embedding model",
};

function countDependents(page?: Pick<DependentsPage, "totalByKind" | "items">): number {
  if (!page) return 0;
  const fromTotals = Object.values(page.totalByKind ?? {}).reduce(
    (sum, value) => sum + (typeof value === "number" ? value : 0),
    0,
  );
  if (fromTotals > 0) return fromTotals;
  return page.items?.length ?? 0;
}

function formatDependentKind(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/_/g, " ");
}

function formatDependentRelation(relation: string): string {
  return RELATION_LABELS[relation] ?? relation.replace(/_/g, " ");
}

function formatModelDeleteError(err: unknown): string {
  const data = (err as { data?: { error?: string; code?: string } } | undefined)?.data;
  if (data?.code === "HAS_DEPENDENTS") {
    return "This model is still used by one or more agents, teams, knowledge bases, or evaluations. Remove those references, then try again.";
  }
  if (typeof data?.error === "string" && data.error.length > 0) {
    return data.error;
  }
  return "Couldn't delete this model. Please try again.";
}

export {
  countDependents,
  formatDependentKind,
  formatDependentRelation,
  formatModelDeleteError,
};
