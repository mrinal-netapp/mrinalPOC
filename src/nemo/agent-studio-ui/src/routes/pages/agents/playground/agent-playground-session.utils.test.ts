import { describe, expect, it } from "vitest";

import type { AgentSessionDetailResponse } from "@/routes/pages/agents/api/agents.types";
import { NEW_CONVERSATION_SESSION_ID } from "../agents.consts";
import {
  buildExecutionStepsFromSessionMessages,
  buildPlaygroundRunMetricsFromSessionDetail,
  getAgentSessionSummaryId,
  isNewConversationSessionId,
  mergeAgentSessionSummaries,
  sessionMessagesToPlaygroundMessages,
} from "./agent-playground-session.utils";

describe("agent-playground-session.utils", () => {
  it("[tag:agents] resolves session summary id from sessionId", () => {
    expect(getAgentSessionSummaryId({ sessionId: "sess-1" })).toBe("sess-1");
  });

  it("[tag:agents] merges pending session ids ahead of api sessions", () => {
    const merged = mergeAgentSessionSummaries(
      [{ sessionId: "sess-api", name: "API session" }],
      ["sess-new", "sess-api"],
    );

    expect(merged.map((session) => session.sessionId)).toEqual(["sess-new", "sess-api"]);
    expect(merged[0]?.name).toBe("");
  });

  it("[tag:agents] detects new conversation sentinel session id", () => {
    expect(isNewConversationSessionId(null)).toBe(true);
    expect(isNewConversationSessionId(NEW_CONVERSATION_SESSION_ID)).toBe(true);
    expect(isNewConversationSessionId("sess-1")).toBe(false);
  });

  it("[tag:agents] maps session messages to playground chat messages", () => {
    const messages = sessionMessagesToPlaygroundMessages([
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: "Hi there",
        latencyMs: 120,
        modelName: "gpt-5.4",
        usage: { totalTokens: 42 },
        citations: [{ knowledgeBaseId: "kb-1", score: 1 }],
      },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", content: "Hello" });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "Hi there",
      latencyMs: 120,
      modelName: "gpt-5.4",
      usage: { totalTokens: 42 },
    });
  });

  it("[tag:agents] builds execution steps from the latest assistant tool calls", () => {
    const steps = buildExecutionStepsFromSessionMessages([
      { role: "user", content: "query" },
      {
        role: "assistant",
        content: "answer",
        toolCalls: [
          {
            toolCallId: "call-1",
            toolName: "search_knowledge_base",
            args: { query: "movies" },
            result: [{ title: "source", content: "title: MOVIE", score: 1 }],
            latencyMs: 95,
          },
        ],
      },
    ]);

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      toolCallId: "call-1",
      toolName: "search_knowledge_base",
      status: "completed",
      elapsedMs: 95,
    });
    expect(steps[0]?.displayName).toBe("Knowledge base retrieval");
  });

  it("[tag:agents] builds run metrics from session detail", () => {
    const session: AgentSessionDetailResponse = {
      sessionId: "sess-1",
      name: "Session 1",
      createdAt: "2026-05-28T08:38:47.597950+00:00",
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: "Hi",
          traceId: "trace-1",
          latencyMs: 500,
          modelName: "gpt-5.4",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          kbStats: [
            {
              knowledgeBaseId: "kb-1",
              knowledgeBaseName: "Docs",
              retrievedChunks: 3,
              tokensUsed: 120,
            },
          ],
          toolStats: [
            {
              toolCallId: "call-1",
              toolName: "search_knowledge_base",
              serverName: null,
              serverId: null,
              status: "executed",
              latencyMs: 95,
            },
          ],
          modelConfig: { temperature: 0.7, maxTokens: 4096 },
        },
      ],
    };

    const metrics = buildPlaygroundRunMetricsFromSessionDetail(session);

    expect(metrics).toMatchObject({
      sessionId: "sess-1",
      traceId: "trace-1",
      latencyMs: 500,
      modelName: "gpt-5.4",
      usage: { totalTokens: 15 },
    });
    expect(metrics?.kbStats).toHaveLength(1);
    expect(metrics?.toolStats).toHaveLength(1);
    expect(metrics?.executionSteps).toHaveLength(0);
  });

  it("[tag:agents] sources scored citations from the persisted MAF agent trace", () => {
    const session: AgentSessionDetailResponse = {
      sessionId: "sess-2",
      name: "Session 2",
      createdAt: "2026-05-28T08:38:47.597950+00:00",
      messages: [
        { role: "user", content: "What is GCNV?" },
        {
          role: "assistant",
          content: "GCNV is ...",
          metadata: {
            citations: {
              // Flat aggregate drops `score`; the per-tool trace keeps it.
              kbCitations: [{ source: "plan-and-prepare-service-perimeter.txt" }],
              agentTrace: [
                {
                  agentName: "GCNV_Agent",
                  toolExecutions: [
                    {
                      toolName: "kb_retrieve",
                      toolType: "kb",
                      kbCitations: [
                        { source: "a.txt", score: 0.961166253101737 },
                        { source: "b.txt", score: 0.8848013453857473 },
                        { source: "c.txt", score: 0.8446333078686019 },
                        { source: "d.txt", score: 0.5 },
                        { source: "e.txt", score: 0.5 },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    } as AgentSessionDetailResponse;

    const metrics = buildPlaygroundRunMetricsFromSessionDetail(session);
    const scores = (metrics?.citations ?? []).map((citation) => citation.score);

    expect(scores).toEqual([
      0.961166253101737,
      0.8848013453857473,
      0.8446333078686019,
      0.5,
      0.5,
    ]);
  });
});
