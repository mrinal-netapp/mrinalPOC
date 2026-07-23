import type { DependentItem, DependentsPage } from "@/routes/pages/agents/api/agents-config.types";
import { toast } from "@/ui-lib/base-components/toast/toast";

import { extractApiErrorMessage } from "./api-error.utils";

const KIND_LABELS: Record<string, string> = {
  agent: "Agent",
  agent_team: "Agent team",
  evaluation: "Evaluation",
  knowledge_base: "Knowledge base",
  dataset: "Dataset",
  pipeline: "Pipeline",
  mcp_server: "Tool",
  credential: "Credential",
  model: "Model",
};

const BLOCKED_TOAST_DURATION_MS = 8000;

type DeleteErrorData = {
  error?: string;
  code?: string;
  dependents?: unknown;
};

function getDeleteErrorData(err: unknown): DeleteErrorData | undefined {
  if (typeof err !== "object" || err == null) return undefined;
  return (err as { data?: DeleteErrorData }).data;
}

function getDependentsFromDeleteError(err: unknown): DependentsPage | null {
  const data = getDeleteErrorData(err);
  const d = data?.dependents;
  if (!d || typeof d !== "object") return null;
  const candidate = d as Partial<DependentsPage>;
  if (!Array.isArray(candidate.items)) return null;
  return {
    items: candidate.items as DependentItem[],
    nextCursor: candidate.nextCursor ?? null,
    totalByKind: candidate.totalByKind ?? {},
  };
}

function formatDependentKind(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/_/g, " ");
}

function formatDependentLabel(item: DependentItem): string {
  const kind = formatDependentKind(item.kind);
  const name = item.name?.trim() || item.id;
  return `${kind}: ${name}`;
}

function countDependentsInPage(page: DependentsPage): number {
  const fromTotals = Object.values(page.totalByKind ?? {}).reduce(
    (sum, value) => sum + (typeof value === "number" ? value : 0),
    0,
  );
  if (fromTotals > 0) return fromTotals;
  return page.items.length;
}

function formatDependentsDescription(page: DependentsPage, maxItems = 5): string | undefined {
  if (page.items.length === 0) return undefined;
  const lines = page.items.slice(0, maxItems).map(formatDependentLabel);
  const total = countDependentsInPage(page);
  const remaining = total - lines.length;
  if (remaining > 0) {
    lines.push(`and ${remaining} more…`);
  }
  return lines.join("\n");
}

function isStructuredDeleteApiError(err: unknown): boolean {
  if (err instanceof Error) return false;
  if (typeof err !== "object" || err == null) return false;
  return "data" in err || "error" in err || "status" in err;
}

function showDeleteBlockedToast(
  err: unknown,
  options: {
    blockedFallback: string;
    genericFallback: string;
  },
): void {
  const data = getDeleteErrorData(err);
  if (data?.code === "HAS_DEPENDENTS") {
    const title =
      (typeof data.error === "string" && data.error.trim()) || options.blockedFallback;
    const dependents = getDependentsFromDeleteError(err);
    const description = dependents ? formatDependentsDescription(dependents) : undefined;
    toast.warning(title, {
      ...(description ? { description } : {}),
      duration: BLOCKED_TOAST_DURATION_MS,
    });
    return;
  }

  const message = isStructuredDeleteApiError(err)
    ? extractApiErrorMessage(err, options.genericFallback)
    : options.genericFallback;
  toast.error(message);
}

function showDatasetDeleteErrorToast(err: unknown, entityName?: string): void {
  showDeleteBlockedToast(err, {
    blockedFallback:
      "Cannot delete this dataset because it is still in use. Update or remove those references, then try again.",
    genericFallback: entityName
      ? `Failed to delete "${entityName}".`
      : "Failed to delete dataset.",
  });
}

function showKnowledgeBaseDeleteErrorToast(err: unknown, entityName?: string): void {
  showDeleteBlockedToast(err, {
    blockedFallback:
      "Cannot delete this knowledge base because it is still in use. Update or remove those references, then try again.",
    genericFallback: entityName
      ? `Failed to delete "${entityName}".`
      : "Failed to delete knowledge base.",
  });
}

export {
  formatDependentKind,
  formatDependentLabel,
  formatDependentsDescription,
  getDependentsFromDeleteError,
  showDatasetDeleteErrorToast,
  showDeleteBlockedToast,
  showKnowledgeBaseDeleteErrorToast,
};
