import type { FetchBaseQueryError } from "@reduxjs/toolkit/query";

import type { UnmetRequirement } from "@/routes/pages/agents/api/agents-config.types";
import { extractApiErrorMessage } from "@/utils/api-error.utils";

const KIND_LABELS: Record<UnmetRequirement["kind"], string> = {
  knowledgeBases: "knowledge base",
  mcpServers: "toolset",
};

function isUnmetRequirementKind(value: unknown): value is UnmetRequirement["kind"] {
  return value === "knowledgeBases" || value === "mcpServers";
}

function parseUnmetRequirementEntry(value: unknown): UnmetRequirement | null {
  if (typeof value !== "object" || value == null) return null;
  const entry = value as Record<string, unknown>;
  if (!isUnmetRequirementKind(entry.kind)) return null;
  if (typeof entry.id !== "string" || !entry.id.trim()) return null;
  if (typeof entry.label !== "string" || !entry.label.trim()) return null;
  return {
    kind: entry.kind,
    id: entry.id,
    label: entry.label.trim(),
  };
}

function parseUnmetRequirements(error: unknown): UnmetRequirement[] {
  if (typeof error !== "object" || error == null) return [];
  const fetchError = error as FetchBaseQueryError;
  if (!("data" in fetchError) || typeof fetchError.data !== "object" || fetchError.data == null) {
    return [];
  }
  const data = fetchError.data as Record<string, unknown>;
  if (!Array.isArray(data.unmetRequirements)) return [];
  return data.unmetRequirements
    .map(parseUnmetRequirementEntry)
    .filter((entry): entry is UnmetRequirement => entry != null);
}

function formatUnmetRequirementsMessage(unmet: UnmetRequirement[]): string {
  if (unmet.length === 0) {
    return "Configure required resources before deploying.";
  }
  const items = unmet.map((req) => `${req.label} (${KIND_LABELS[req.kind]})`);
  return `Configure required resources before deploying: ${items.join(", ")}.`;
}

function formatAgentSaveErrorMessage(
  error: unknown,
  options: { agentName: string; saveSucceeded: boolean },
): string {
  const unmet = parseUnmetRequirements(error);
  if (unmet.length > 0) {
    return formatUnmetRequirementsMessage(unmet);
  }

  const saveFallback = `Failed to save ${options.agentName}. Please try again.`;

  if (options.saveSucceeded) {
    const deployFallback = "Deploy failed. Please try again.";
    const deployDetail = extractApiErrorMessage(error, deployFallback);
    return `Saved ${options.agentName} as draft, but deploy failed. ${deployDetail}`;
  }

  const apiMessage = extractApiErrorMessage(error, saveFallback);

  if (apiMessage !== saveFallback) {
    return `Failed to save ${options.agentName}. ${apiMessage}`;
  }

  return saveFallback;
}

export {
  formatAgentSaveErrorMessage,
  formatUnmetRequirementsMessage,
  parseUnmetRequirements,
};
