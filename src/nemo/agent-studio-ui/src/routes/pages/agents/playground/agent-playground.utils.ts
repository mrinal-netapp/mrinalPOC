import type { Agent, AgentMemoryType, ProjectModel } from "@/routes/pages/agents/api/agents.types";
import type { PlaygroundChatMessage } from "./agent-playground.types";

/** Minimal model fields used to resolve gateway/wire ids to registration labels. */
export type PlaygroundModelLookup = {
  id?: string;
  name?: string;
  displayName?: string;
  provider?: string;
  providerModelId?: string;
  gatewayModelId?: string;
};

export type PlaygroundInteractionMode = "single-turn" | "multi-turn";

export type AgentPlaygroundDisplayConfig = {
  agentId: string;
  agentName: string;
  mode: PlaygroundInteractionMode;
  instructions: string;
  temperature: number;
  topP: number;
  topKChunks: number;
  tokenLimit: number;
  modelDisplayName: string;
};

export const INSTRUCTIONS_MAX_LENGTH = 5000;

export const DEFAULT_PLAYGROUND_TOP_P = 0.3;

/** True while GET /agents/{id} is in flight or cached data does not match the requested id. */
export function isAgentDetailPending(
  agentId: string | null | undefined,
  agent: Agent | undefined | null,
  isLoading: boolean,
  isFetching: boolean,
): boolean {
  if (!agentId) {
    return false;
  }
  if (agent?.id === agentId && !isLoading && !isFetching) {
    return false;
  }
  return isLoading || isFetching || agent?.id !== agentId;
}

export function memoryTypeToPlaygroundMode(
  memoryType?: AgentMemoryType,
): PlaygroundInteractionMode {
  if (!memoryType || memoryType === "none") {
    return "single-turn";
  }
  return "multi-turn";
}

export function playgroundModeToMemoryType(mode: PlaygroundInteractionMode): AgentMemoryType {
  return mode === "single-turn" ? "none" : "conversation";
}

export function resolveModelDisplayName(
  agent: Agent,
  models: ProjectModel[],
): string {
  if (agent.modelId) {
    const match = models.find((m) => m.id === agent.modelId);
    if (match?.displayName) {
      return match.displayName;
    }
    if (match?.name) {
      return match.name;
    }
  }
  if (agent.modelClass) {
    return agent.modelClass;
  }
  return "—";
}

export function agentToDisplayConfig(
  agent: Agent,
  models: ProjectModel[],
  topP = DEFAULT_PLAYGROUND_TOP_P,
): AgentPlaygroundDisplayConfig {
  return {
    agentId: agent.id,
    agentName: agent.name,
    mode: memoryTypeToPlaygroundMode(agent.memoryType),
    instructions: agent.systemPrompt ?? "",
    temperature: agent.temperature ?? 0.7,
    topP,
    // ragConfig is a per-KB map — use the first entry's topK for the playground
    // config panel (single shared slider). Falls back to 6 when no KBs attached.
    topKChunks: (agent.ragConfig ? Object.values(agent.ragConfig)[0]?.topK : undefined) ?? 6,
    tokenLimit: agent.maxTokens ?? 2000,
    modelDisplayName: resolveModelDisplayName(agent, models),
  };
}

export function formatPlaygroundLatency(latencyMs: number | undefined): string {
  if (latencyMs === undefined || !Number.isFinite(latencyMs)) {
    return "";
  }
  return `${Math.round(latencyMs)} ms`;
}

export function formatPlaygroundTotalTokens(totalTokens: number | undefined | null): string {
  if (totalTokens === undefined || totalTokens === null || !Number.isFinite(totalTokens)) {
    return "";
  }
  return totalTokens.toLocaleString("en-US");
}

export function formatPlaygroundModelLabel(
  modelName: string | undefined,
  models: PlaygroundModelLookup[] = [],
): string {
  const resolved = resolvePlaygroundModelName(modelName, models);
  if (!resolved) {
    return "";
  }

  const gptMatch = /^gpt-(.+)$/i.exec(resolved);
  if (gptMatch) {
    const suffix = gptMatch[1];
    return `GPT-${suffix.charAt(0).toUpperCase()}${suffix.slice(1)}`;
  }

  return resolved;
}

/** Map a wire/gateway model id to the registration display name when possible. */
export function resolvePlaygroundModelName(
  raw: string | undefined,
  models: PlaygroundModelLookup[] = [],
): string | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  const trimmed = raw.trim();
  for (const model of models) {
    const label = model.displayName?.trim() || model.name?.trim();
    if (!label) {
      continue;
    }
    if (model.id === trimmed || model.name === trimmed || model.displayName === trimmed) {
      return label;
    }
    const gatewayModelId = "gatewayModelId" in model ? model.gatewayModelId : undefined;
    if (gatewayModelId && gatewayModelId === trimmed) {
      return label;
    }
    if (model.provider && model.providerModelId) {
      const built = `${model.provider}/${model.providerModelId}`;
      if (built === trimmed) {
        return label;
      }
    }
    if (model.providerModelId && (trimmed.endsWith(`/${model.providerModelId}`) || trimmed.endsWith(`_${model.providerModelId}`))) {
      return label;
    }
  }

  if (trimmed.includes("/")) {
    return trimmed.split("/").pop() ?? trimmed;
  }

  return trimmed;
}

export function formatCitationSourceLabel(source: string | undefined): string {
  if (!source?.trim()) {
    return "Unknown source";
  }
  const parts = source.split("/");
  return parts[parts.length - 1] || source;
}

export function hasPlaygroundMessageMetadata(message: PlaygroundChatMessage): boolean {
  if (message.role !== "assistant" || message.isStreaming) {
    return false;
  }

  return (
    message.latencyMs !== undefined
    || message.usage?.totalTokens != null
    || Boolean(message.modelName?.trim())
    || (message.citations?.length ?? 0) > 0
  );
}

export function formatPlaygroundToolStatus(status: string | undefined): string {
  if (!status?.trim()) {
    return "—";
  }
  const normalized = status.trim();
  return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
}

export function buildAgentUpdateFromConfigureForm(
  agent: Agent,
  values: {
    mode: PlaygroundInteractionMode;
    instructions: string;
    temperature: number;
    topK: number;
    tokenLimit: number;
  },
): {
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  memoryType: AgentMemoryType;
  ragConfig: NonNullable<Agent["ragConfig"]>;
} {
  // ragConfig is per-KB — propagate the playground topK slider value to every
  // attached KB entry, preserving all other per-KB settings unchanged.
  const updatedRagConfig: NonNullable<Agent["ragConfig"]> = agent.ragConfig
    ? Object.fromEntries(
        Object.entries(agent.ragConfig).map(([kbId, cfg]) => [
          kbId,
          { ...cfg, topK: values.topK },
        ]),
      )
    : {};

  return {
    systemPrompt: values.instructions.trim(),
    temperature: values.temperature,
    maxTokens: values.tokenLimit,
    memoryType: playgroundModeToMemoryType(values.mode),
    ragConfig: updatedRagConfig,
  };
}
