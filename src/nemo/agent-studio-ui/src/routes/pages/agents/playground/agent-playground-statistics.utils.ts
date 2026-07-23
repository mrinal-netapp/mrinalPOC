import type { AgentCitation, AgentTraceSpan } from "@/routes/pages/agents/api/agents.types";
import type { AgentPlaygroundDisplayConfig } from "./agent-playground.utils";
import type { PlaygroundRunMetrics } from "./agent-playground.types";
import { getSpanDurationMs } from "./agent-playground-tracing.utils";

export type PlaygroundRunStatisticsRow = {
  label: string;
  value: string;
};

export type PlaygroundRunStatisticsSection = {
  title: string;
  rows: PlaygroundRunStatisticsRow[];
};

export type PlaygroundRunStatisticsViewModel = {
  sections: PlaygroundRunStatisticsSection[];
  isEmpty: boolean;
};

const TIMING_ROWS = [
  { key: "latency", label: "Latency" },
  { key: "timeToFirstToken", label: "Time to First Token" },
  { key: "generationTime", label: "Generation time" },
] as const;

const TOKEN_ROWS = [
  { key: "totalTokens", label: "Total tokens" },
  { key: "inputTokens", label: "Input tokens" },
  { key: "outputTokens", label: "Output tokens" },
] as const;

const COST_ROWS = [
  { key: "actualCost", label: "Actual cost" },
  { key: "totalModelCost", label: "Total model cost" },
  { key: "modelInputCost", label: "Model input cost" },
  { key: "modelOutputCost", label: "Model output cost" },
] as const;

const RETRIEVAL_ROWS = [
  { key: "chunksFound", label: "Chunks found" },
  { key: "averageRelevance", label: "Average relevance" },
  { key: "contextWindowUsage", label: "Context window usage" },
] as const;

const TOOL_ROWS = [
  { key: "successRate", label: "Success rate" },
  { key: "executedSuccessfully", label: "Executed successfully" },
] as const;

const SUCCESS_TOOL_STATUSES = new Set(["executed", "success", "completed", "ok"]);

const TIME_TO_FIRST_TOKEN_ATTRIBUTE_KEYS = [
  "gen_ai.response.time_to_first_token",
  "gen_ai.response.time_to_first_token_ms",
  "llm.time_to_first_token_ms",
  "time_to_first_token_ms",
];

function formatDurationMs(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "";
  }
  return `${Math.round(value)} ms`;
}

function formatTokenCount(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return "";
  }
  return value.toLocaleString("en-US");
}

function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "";
  }
  return `${Math.round(value)}%`;
}

function formatRatio(successful: number, total: number): string {
  if (total <= 0) {
    return "";
  }
  return `${successful}/${total}`;
}

function readNumericAttribute(
  attributes: Record<string, unknown> | null | undefined,
  keys: string[],
): number | undefined {
  if (!attributes) {
    return undefined;
  }

  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  for (const [key, value] of Object.entries(attributes)) {
    const normalizedKey = key.toLowerCase();
    if (
      !normalizedKey.includes("first_token")
      && !normalizedKey.includes("ttft")
    ) {
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function isLlmSpan(span: AgentTraceSpan): boolean {
  const name = span.name?.toLowerCase() ?? "";
  if (
    name.includes("llm")
    || name.includes("chat.completions")
    || name.includes("completion")
  ) {
    return true;
  }
  const modelName = span.attributes?.["llm.model_name"];
  return typeof modelName === "string" && modelName.trim().length > 0;
}

function getTimeToFirstTokenMs(spans: AgentTraceSpan[]): number | undefined {
  for (const span of spans) {
    const value = readNumericAttribute(
      span.attributes,
      TIME_TO_FIRST_TOKEN_ATTRIBUTE_KEYS,
    );
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function getGenerationTimeMs(spans: AgentTraceSpan[]): number | undefined {
  let total = 0;
  let hasValue = false;

  for (const span of spans) {
    if (!isLlmSpan(span)) {
      continue;
    }
    const durationMs = getSpanDurationMs(span);
    if (durationMs === null) {
      continue;
    }
    total += durationMs;
    hasValue = true;
  }

  return hasValue ? total : undefined;
}

function sumRetrievedChunks(metrics: PlaygroundRunMetrics): number | undefined {
  const kbStats = metrics.kbStats ?? [];
  if (kbStats.length === 0) {
    return undefined;
  }
  return kbStats.reduce((sum, stat) => sum + stat.retrievedChunks, 0);
}

function sumKbTokensUsed(metrics: PlaygroundRunMetrics): number | undefined {
  const kbStats = metrics.kbStats ?? [];
  if (kbStats.length === 0) {
    return undefined;
  }
  return kbStats.reduce((sum, stat) => sum + stat.tokensUsed, 0);
}

/**
 * Collect every scored KB citation for the run. The authoritative per-chunk
 * relevance scores live on each tool execution
 * (`provenance.agentTrace[].toolExecutions[].kbCitations[]`) — the same source
 * the "Chunks found" metric counts. The flat top-level `metrics.citations` is a
 * deduped aggregate that drops `score` on MAF payloads, so prefer the nested
 * citations and fall back to the top-level list only when provenance is absent.
 */
function collectScoredCitations(metrics: PlaygroundRunMetrics): AgentCitation[] {
  const fromProvenance = (metrics.provenance?.agentTrace ?? []).flatMap((step) =>
    (step.toolExecutions ?? []).flatMap((te) => te.kbCitations ?? []),
  );
  if (fromProvenance.length > 0) {
    return fromProvenance;
  }
  return metrics.citations ?? [];
}

function getAverageCitationRelevance(
  citations: AgentCitation[] | undefined,
): number | undefined {
  if (!citations || citations.length === 0) {
    return undefined;
  }

  const scores = citations
    .map((citation) => citation.score)
    .filter((score): score is number => typeof score === "number" && Number.isFinite(score));

  if (scores.length === 0) {
    return undefined;
  }

  const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  return average <= 1 ? average * 100 : average;
}

function getContextWindowUsagePercent(
  metrics: PlaygroundRunMetrics,
  displayConfig: AgentPlaygroundDisplayConfig | null,
): number | undefined {
  const kbTokens = sumKbTokensUsed(metrics);
  const contextLimit =
    metrics.modelConfig?.maxTokens
    ?? displayConfig?.tokenLimit;

  if (
    kbTokens === undefined
    || contextLimit === undefined
    || !Number.isFinite(contextLimit)
    || contextLimit <= 0
  ) {
    return undefined;
  }

  return (kbTokens / contextLimit) * 100;
}

function isSuccessfulToolStatus(status: string | undefined): boolean {
  if (!status?.trim()) {
    return false;
  }
  return SUCCESS_TOOL_STATUSES.has(status.trim().toLowerCase());
}

function buildSection(
  title: string,
  rows: readonly { label: string; value: string }[],
): PlaygroundRunStatisticsSection {
  return { title, rows: rows.map((row) => ({ ...row })) };
}

export function buildPlaygroundRunStatistics(
  metrics: PlaygroundRunMetrics | null,
  spans: AgentTraceSpan[],
  displayConfig: AgentPlaygroundDisplayConfig | null,
): PlaygroundRunStatisticsViewModel {
  if (!metrics) {
    return { sections: [], isEmpty: true };
  }

  const usage = metrics.usage;
  const toolStats = metrics.toolStats ?? [];
  const successfulTools = toolStats.filter((stat) => isSuccessfulToolStatus(stat.status)).length;
  const toolTotal = toolStats.length;

  // maf's `citations.performance` surfaces the LLM-only duration when
  // Phoenix tracing isn't available; use it as a fallback for Generation
  // time so the timing section doesn't render empty for maf invocations.
  const performance = metrics.provenance?.performance;
  const timingValues = {
    latency: formatDurationMs(metrics.latencyMs ?? performance?.totalDurationMs),
    timeToFirstToken: formatDurationMs(getTimeToFirstTokenMs(spans)),
    generationTime: formatDurationMs(
      getGenerationTimeMs(spans) ?? performance?.llmDurationMs,
    ),
  };

  const tokenValues = {
    totalTokens: formatTokenCount(usage?.totalTokens),
    inputTokens: formatTokenCount(usage?.promptTokens),
    outputTokens: formatTokenCount(usage?.completionTokens),
  };

  const costValues = {
    actualCost: "",
    totalModelCost: "",
    modelInputCost: "",
    modelOutputCost: "",
  };

  const retrievalValues = {
    chunksFound: (() => {
      const chunks = sumRetrievedChunks(metrics);
      return chunks === undefined ? "" : String(chunks);
    })(),
    averageRelevance: formatPercent(getAverageCitationRelevance(collectScoredCitations(metrics))),
    contextWindowUsage: (() => {
      const usagePercent = getContextWindowUsagePercent(metrics, displayConfig);
      if (usagePercent === undefined) {
        return "";
      }
      const formatted =
        usagePercent >= 10
          ? Math.round(usagePercent)
          : Number(usagePercent.toFixed(1));
      return `${formatted}%`;
    })(),
  };

  const toolValues = {
    successRate:
      toolTotal > 0
        ? formatPercent((successfulTools / toolTotal) * 100)
        : "",
    executedSuccessfully: formatRatio(successfulTools, toolTotal),
  };

  const sections = [
    buildSection(
      "Timing",
      TIMING_ROWS.map((row) => ({
        label: row.label,
        value: timingValues[row.key],
      })),
    ),
    buildSection(
      "Tokens",
      TOKEN_ROWS.map((row) => ({
        label: row.label,
        value: tokenValues[row.key],
      })),
    ),
    buildSection(
      "Cost",
      COST_ROWS.map((row) => ({
        label: row.label,
        value: costValues[row.key],
      })),
    ),
    buildSection(
      "Retrieval performance",
      RETRIEVAL_ROWS.map((row) => ({
        label: row.label,
        value: retrievalValues[row.key],
      })),
    ),
    buildSection(
      "Tool execution",
      TOOL_ROWS.map((row) => ({
        label: row.label,
        value: toolValues[row.key],
      })),
    ),
  ];

  return {
    sections,
    isEmpty: false,
  };
}
