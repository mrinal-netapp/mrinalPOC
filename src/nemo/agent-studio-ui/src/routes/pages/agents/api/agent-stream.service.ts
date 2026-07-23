/**
 * Pure SSE transport layer for the Agent Service streaming invoke endpoints.
 *
 * This module is the ONLY place that knows how HTTP/SSE works for agent streaming.
 * All other code (hooks, components) depend on the `AgentSseEvent` type contract
 * and the `streamAgentInvoke` function signature — not on fetch or SSE details.
 * Swapping the transport (e.g. to WebSocket or gRPC-web) means replacing this
 * file only.
 *
 * Source of truth: agent-service FastAPI (`src/nemo/agent-service/src/main.py`),
 * the `invoke_agent_stream` / `invoke_team_stream` handlers.
 *   POST /api/v1/projects/{project_id}/agents/{agent_id}/invoke/stream
 *   POST /api/v1/projects/{project_id}/agent-teams/{team_id}/invoke/stream
 *
 * The richer response shapes in `agent-stream.yaml` are the eventual target;
 * this layer matches what agent-service emits today and can be widened later.
 */
import type {
  AgentSseEvent,
  AgentStreamDonePayload,
  AgentStreamInvokeRequest,
  AgentStreamProvenance,
  AgentStreamTraceStep,
} from "./agents.types";
import { buildNemoContextHeaders } from "@/api/api.slice";

/**
 * Parse one raw SSE chunk (the text between two `\n\n` delimiters) into a
 * typed event.  Returns `null` for comment lines (`: ping`) and unknown events.
 */
function parseSseChunk(chunk: string): AgentSseEvent | null {
  let eventType = "";
  const dataLines: string[] = [];

  // Lines within an SSE event may be terminated by "\n", "\r\n", or "\r"
  // (the agent-service emits CRLF). Split on all three so the field prefixes
  // are recognised and no stray "\r" leaks into the parsed values.
  for (const line of chunk.split(/\r\n|\n|\r/)) {
    if (line.startsWith("event:")) {
      eventType = line.slice(line.indexOf(":") + 1).trim();
    } else if (line.startsWith("data:")) {
      // Per the SSE spec a single space immediately after the colon is part
      // of the delimiter and stripped; any further spaces are payload.
      const value = line.slice(line.indexOf(":") + 1);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }

  // Multiple `data:` lines are concatenated with newlines (SSE spec).
  const dataLine = dataLines.join("\n");
  if (!eventType || dataLines.length === 0) return null;

  // maf wraps every event payload as `{data, metadata, timestamp}` JSON.
  // Legacy agent-service emits bare strings (message/error) or direct
  // JSON (done/tool_call_*). Try to parse once and pass `envelope` to the
  // maf-shaped cases; the legacy cases keep using `dataLine` verbatim.
  type SseEnvelope = {
    data?: unknown;
    metadata?: Record<string, unknown>;
    timestamp?: string;
  };
  let envelope: SseEnvelope | null = null;
  try {
    const parsed: unknown = JSON.parse(dataLine);
    if (parsed && typeof parsed === "object") {
      envelope = parsed as SseEnvelope;
    }
  } catch {
    envelope = null;
  }
  const innerData = envelope?.data;
  const metadata = (envelope?.metadata ?? {}) as Record<string, unknown>;

  switch (eventType) {
    // ── Legacy agent-service ──────────────────────────────────────────
    case "message":
      return { type: "message", data: dataLine };

    case "tool_call_start":
    case "tool_call_result":
    case "done": {
      try {
        const parsed: unknown = JSON.parse(dataLine);
        return { type: eventType, data: parsed } as AgentSseEvent;
      } catch {
        return null;
      }
    }

    // ── maf vocabulary (interfaces.py EventType) ──────────────────────
    case "token":
      // Inner `data` is the text chunk. Render as a "message" event so the
      // playground's existing assistantTextAppended path concatenates it.
      return { type: "message", data: typeof innerData === "string" ? innerData : "" };

    case "tool_call":
      if (innerData && typeof innerData === "object") {
        const d = innerData as Record<string, unknown>;
        return {
          type: "tool_call_start",
          data: {
            toolCallId: String(d.toolCallId ?? d.tool_call_id ?? d.id ?? ""),
            toolName: String(d.toolName ?? d.tool_name ?? d.name ?? ""),
            args: (d.args ?? d.arguments ?? {}) as Record<string, unknown>,
            memberName: (d.memberName ?? d.member_name ?? null) as string | null,
            memberId: (d.memberId ?? d.member_id ?? null) as string | null,
          },
        };
      }
      return null;

    case "tool_result":
      if (innerData && typeof innerData === "object") {
        const d = innerData as Record<string, unknown>;
        return {
          type: "tool_call_result",
          data: {
            toolCallId: String(d.toolCallId ?? d.tool_call_id ?? d.id ?? ""),
            result: d.result ?? innerData,
            memberName: (d.memberName ?? d.member_name ?? null) as string | null,
            memberId: (d.memberId ?? d.member_id ?? null) as string | null,
          },
        };
      }
      return null;

    case "completed": {
      // maf bundles the typed InvokeResponse in metadata.invokeResponse.
      // citations is the structured Citations envelope (Citations §5.3.5):
      //   { respondingAgent, routing, contextUsed, agentTrace[], performance,
      //     kbCitations[] }
      // The UI's done.citations is a flat AgentCitation[] — maf's KbCitation
      // has matching field names (source/documentId/downloadUrl/knowledgeBaseId/
      // knowledgeBaseName/score), so kbCitations maps 1:1. The agentTrace's
      // toolExecutions feed the Run Details tab's Statistics view.
      const invokeResponse = (metadata.invokeResponse ?? {}) as Record<string, unknown>;
      type MafToolExecution = {
        toolName?: string;
        toolCallId?: string;
        arguments?: unknown;
        resultSummary?: unknown;
        durationMs?: number;
        error?: string | null;
        // MAF tool discriminator: "kb" for kb_retrieve & equivalents,
        // "toolset" for MCP / external tools. Used to branch UI rendering.
        toolType?: "kb" | "toolset";
        // Approximate context tokens this tool's response will consume on
        // the next LLM call. Populated by KB tools today.
        tokensUsed?: number | null;
        kbCitations?: Array<{
          knowledgeBaseId?: string;
          knowledgeBaseName?: string;
        }> | null;
      };
      type MafAgentTraceStep = {
        toolExecutions?: MafToolExecution[];
      };
      const cit = (invokeResponse.citations ?? {}) as {
        respondingAgent?: AgentStreamProvenance["respondingAgent"];
        performance?: AgentStreamProvenance["performance"];
        kbCitations?: AgentStreamDonePayload["citations"];
        agentTrace?: (AgentStreamTraceStep & MafAgentTraceStep)[];
      };
      const provenance: AgentStreamProvenance | undefined =
        cit.respondingAgent || cit.agentTrace?.length || cit.performance
          ? {
              respondingAgent: cit.respondingAgent,
              agentTrace: cit.agentTrace?.map((step) => ({
                stepIndex: step.stepIndex,
                agentName: step.agentName,
                action: step.action,
                // Carry the per-step input through to the live provenance so the
                // Tracing tab renders the agent's received message right after a
                // live run, matching the persisted GET /sessions/{id} path.
                input: step.input,
                output: step.output,
                durationMs: step.durationMs,
                round: step.round,
                timestamp: step.timestamp,
                // Preserve nested tool executions so the live Execution /
                // Tracing tabs can render them from `lastRunMetrics.provenance`
                // without waiting for a persisted GET /sessions/{id}.
                toolExecutions: step.toolExecutions?.map((te) => ({
                  toolName: te.toolName,
                  toolCallId: te.toolCallId,
                  arguments: te.arguments,
                  resultSummary: te.resultSummary,
                  durationMs: te.durationMs,
                  error: te.error,
                  // Carry MAF's KB/toolset discriminator + per-tool token
                  // count + per-call citations onto the provenance so the
                  // right-rail config panel can render tool-type-specific
                  // detail rows without a session GET round-trip.
                  toolType: te.toolType,
                  tokensUsed: te.tokensUsed,
                  kbCitations: te.kbCitations ?? null,
                })),
              })),
              performance: cit.performance,
            }
          : undefined;
      const durationMs =
        typeof invokeResponse.durationMs === "number"
          ? (invokeResponse.durationMs as number)
          : cit.performance?.totalDurationMs;
      const modelConfig: AgentStreamDonePayload["modelConfig"] =
        typeof cit.respondingAgent?.temperature === "number"
          ? { temperature: cit.respondingAgent.temperature }
          : undefined;

      // Flatten agentTrace[].toolExecutions[] across all steps into a single
      // tool-stat list for the Run Details > Statistics tab. MAF surfaces
      // `toolType` ("kb" | "toolset") and `tokensUsed`; threaded through to
      // toolStats so the right-rail config panel can branch its rendering.
      const toolExecutions: MafToolExecution[] = (cit.agentTrace ?? []).flatMap(
        (step) => step.toolExecutions ?? [],
      );
      const toolStats: AgentStreamDonePayload["toolStats"] = toolExecutions.length
        ? toolExecutions.map((te) => ({
            toolName: te.toolName ?? "",
            serverName: "",
            serverId: "",
            status: te.error ? "failed" : "completed",
            latencyMs: typeof te.durationMs === "number" ? te.durationMs : 0,
            toolType: te.toolType,
          }))
        : undefined;

      // Aggregate KB stats: sum citation entries per knowledgeBase across all
      // tool executions (an entry per chunk returned by the KB), and sum
      // `tokensUsed` per KB from each tool call (MAF emits a per-call estimate;
      // the sum gives the Statistics panel's "Context window usage" its
      // numerator).
      //
      // NOTE: the "Chunks found" metric counts citation entries verbatim — it
      // does NOT dedupe across multiple kb_retrieve calls in the same run.
      // MAF intentionally drops the chunk-level dedup key from the wire
      // (`KbCitation.chunk_id` is `exclude=True` on the backend model), so the
      // UI has no stable identifier to fold duplicates on. Practically this
      // means a run that calls kb_retrieve twice with overlapping top-k will
      // double-count any chunk that came back in both calls; the surfaced
      // number reads as "total retrievals", not "unique chunks". If dedup is
      // ever needed, expose `chunkId` on the wire and key the accumulator on
      // `(knowledgeBaseId, chunkId)`.
      //
      // Group by toolType==="kb" first so non-KB tools that happen to emit
      // citations don't get bucketed; fall back to knowledgeBaseId so older
      // MAF payloads (pre-toolType) still aggregate via the citation's KB id.
      const kbAccumulator = new Map<
        string,
        { name: string; chunks: number; tokens: number }
      >();
      for (const te of toolExecutions) {
        const isKbTool = te.toolType === "kb" || (te.toolType === undefined && (te.kbCitations?.length ?? 0) > 0);
        if (!isKbTool) continue;
        const citations = te.kbCitations ?? [];
        const tokens = typeof te.tokensUsed === "number" ? te.tokensUsed : 0;
        // KB-tool calls without citations still contribute tokens — attribute
        // them to the first citation's KB id if any later citation shows up,
        // otherwise skip (no aggregation key). Tokens are aggregated by the
        // KB id of the first citation in the call when present.
        const callKbId = citations.find((c) => c.knowledgeBaseId)?.knowledgeBaseId ?? "";
        for (const c of citations) {
          const id = c.knowledgeBaseId ?? "";
          if (!id) continue;
          const entry = kbAccumulator.get(id) ?? {
            name: c.knowledgeBaseName ?? id,
            chunks: 0,
            tokens: 0,
          };
          entry.chunks += 1;
          kbAccumulator.set(id, entry);
        }
        if (callKbId && tokens > 0) {
          const entry = kbAccumulator.get(callKbId);
          if (entry) {
            entry.tokens += tokens;
          }
        }
      }
      const kbStats: AgentStreamDonePayload["kbStats"] = kbAccumulator.size
        ? Array.from(kbAccumulator.entries()).map(([id, v]) => ({
            knowledgeBaseId: id,
            knowledgeBaseName: v.name,
            retrievedChunks: v.chunks,
            tokensUsed: v.tokens,
          }))
        : undefined;

      return {
        type: "done",
        data: {
          sessionId: String(invokeResponse.sessionId ?? ""),
          latencyMs: typeof durationMs === "number" ? durationMs : undefined,
          modelName: cit.respondingAgent?.model,
          usage: (invokeResponse.usage as AgentStreamDonePayload["usage"]) ?? null,
          citations: Array.isArray(cit.kbCitations) ? cit.kbCitations : null,
          traceId:
            typeof invokeResponse.traceId === "string"
              ? (invokeResponse.traceId as string)
              : undefined,
          modelConfig,
          toolStats,
          kbStats,
          provenance,
        },
      };
    }

    case "error":
      return {
        type: "error",
        data: typeof innerData === "string" ? innerData : dataLine,
      };

    // ── Per-agent (team) lifecycle ────────────────────────────────────
    // maf emits agent_started / agent_completed around each participant turn
    // in a multi-agent orchestration. metadata carries agentName (+ timing).
    case "agent_started": {
      const agentName = String(metadata.agentName ?? metadata.agent_name ?? "");
      if (!agentName) return null;
      return {
        type: "agent_started",
        data: {
          agentName,
          startedAt:
            typeof metadata.startedAt === "string" ? metadata.startedAt : undefined,
        },
      };
    }

    case "agent_completed": {
      const agentName = String(metadata.agentName ?? metadata.agent_name ?? "");
      if (!agentName) return null;
      return {
        type: "agent_completed",
        data: {
          agentName,
          completedAt:
            typeof metadata.completedAt === "string" ? metadata.completedAt : undefined,
          durationMs:
            typeof metadata.durationMs === "number" ? metadata.durationMs : undefined,
        },
      };
    }

    // Lifecycle events with no UI mapping yet — silently ignored.
    case "started":
    case "thinking":
    case "artifact":
      return null;

    default:
      return null;
  }
}

/**
 * Async generator that streams an agent (or agent-team) invocation over SSE.
 *
 * Usage:
 * ```ts
 * const signal = abortController.signal;
 * for await (const event of streamAgentInvoke(url, request, signal)) {
 *   if (event.type === 'message') { ... }
 *   if (event.type === 'done')    { ... }
 * }
 * ```
 *
 * The generator terminates naturally when the server sends a `done` or `error`
 * event, or when the caller aborts via `signal`.
 */
export async function* streamAgentInvoke(
  url: string,
  request: AgentStreamInvokeRequest,
  signal: AbortSignal,
): AsyncGenerator<AgentSseEvent> {
  let response: Response;

  try {
    const headers = buildNemoContextHeaders(new Headers({ "Content-Type": "application/json" }));
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal,
    });
  } catch (err) {
    if (signal.aborted) return;
    throw err;
  }

  if (!response.ok || !response.body) {
    // Surface the server's human-readable reason (FastAPI puts it in `detail`,
    // e.g. a 413 "exceeds model context window" for teams whose combined
    // system prompt + tools overflow the model window) instead of a bare
    // status code, so the playground can show something actionable.
    let detail = "";
    try {
      const text = await response.text();
      try {
        const parsed = JSON.parse(text) as { detail?: unknown };
        detail = typeof parsed.detail === "string" ? parsed.detail : text;
      } catch {
        detail = text;
      }
    } catch {
      // Body already consumed or unreadable — fall back to the status code.
    }
    throw new Error(detail.trim() || `Agent stream request failed: HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by a blank line, which may use any mix of
      // "\n" / "\r\n" / "\r" line endings. Keep the last (possibly incomplete)
      // chunk in the buffer until its terminating blank line arrives.
      const chunks = buffer.split(/\r\n\r\n|\n\n|\r\r/);
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        if (!chunk.trim()) continue;
        const event = parseSseChunk(chunk);
        if (event) yield event;
        // Stop consuming after a terminal event.
        if (event?.type === "done" || event?.type === "error") return;
      }
    }

    // Flush remaining buffer content after the stream closes.
    if (buffer.trim()) {
      const event = parseSseChunk(buffer);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}
