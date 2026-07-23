import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentSseEvent, AgentStreamInvokeRequest } from "./agents.types";

// Isolate the transport from the header/auth layer.
vi.mock("@/api/api.slice", () => ({
  buildNemoContextHeaders: (headers: Headers) => headers,
}));

import { streamAgentInvoke } from "./agent-stream.service";

const REQUEST = {} as AgentStreamInvokeRequest;

function streamResponse(
  parts: string[],
  init: { ok?: boolean; status?: number; withBody?: boolean; text?: string } = {},
): Response {
  const encoder = new TextEncoder();
  const body =
    init.withBody === false
      ? null
      : new ReadableStream<Uint8Array>({
          start(controller) {
            for (const part of parts) controller.enqueue(encoder.encode(part));
            controller.close();
          },
        });
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    body,
    text: () => Promise.resolve(init.text ?? ""),
  } as unknown as Response;
}

async function collect(
  gen: AsyncGenerator<AgentSseEvent>,
): Promise<AgentSseEvent[]> {
  const events: AgentSseEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function mockFetch(impl: () => Promise<Response> | Response): void {
  vi.stubGlobal("fetch", vi.fn(impl));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamAgentInvoke", () => {
  it("[tag:agent-stream] yields message events and stops at the terminal done event", async () => {
    mockFetch(() =>
      streamResponse([
        "event: message\ndata: Hello\n\n",
        'event: done\ndata: {"sessionId":"s1"}\n\n',
        // Anything after the terminal event must be ignored.
        "event: message\ndata: ignored\n\n",
      ]),
    );

    const events = await collect(
      streamAgentInvoke("/stream", REQUEST, new AbortController().signal),
    );
    expect(events).toEqual([
      { type: "message", data: "Hello" },
      { type: "done", data: { sessionId: "s1" } },
    ]);
  });

  it("[tag:agent-stream] parses tool-call (JSON) events and multiple events in one chunk", async () => {
    mockFetch(() =>
      streamResponse([
        'event: tool_call_start\ndata: {"name":"calc"}\n\nevent: tool_call_result\ndata: {"output":42}\n\n',
      ]),
    );

    const events = await collect(
      streamAgentInvoke("/stream", REQUEST, new AbortController().signal),
    );
    expect(events).toEqual([
      { type: "tool_call_start", data: { name: "calc" } },
      { type: "tool_call_result", data: { output: 42 } },
    ]);
  });

  it("[tag:agent-stream] parses CRLF-delimited events (agent-service wire format)", async () => {
    // agent-service emits "\r\n" line endings and "\r\n\r\n" event separators.
    mockFetch(() =>
      streamResponse([
        "event: message\r\ndata: Hel\r\n\r\n",
        "event: message\r\ndata: lo!\r\n\r\n",
        'event: done\r\ndata: {"sessionId":"s9"}\r\n\r\n',
      ]),
    );

    const events = await collect(
      streamAgentInvoke("/stream", REQUEST, new AbortController().signal),
    );
    expect(events).toEqual([
      { type: "message", data: "Hel" },
      { type: "message", data: "lo!" },
      { type: "done", data: { sessionId: "s9" } },
    ]);
  });

  it("[tag:agent-stream] preserves leading payload spaces beyond the SSE delimiter", async () => {
    mockFetch(() => streamResponse(["event: message\r\ndata:  Th\r\n\r\n"]));
    const events = await collect(
      streamAgentInvoke("/stream", REQUEST, new AbortController().signal),
    );
    expect(events).toEqual([{ type: "message", data: " Th" }]);
  });

  it("[tag:agent-stream] joins multiple data lines with newlines", async () => {
    mockFetch(() =>
      streamResponse([
        "event: message\ndata: first line\ndata: second line\n\n",
      ]),
    );

    const events = await collect(
      streamAgentInvoke("/stream", REQUEST, new AbortController().signal),
    );

    expect(events).toEqual([{ type: "message", data: "first line\nsecond line" }]);
  });

  it("[tag:agent-stream] terminates on an error event", async () => {
    mockFetch(() => streamResponse(["event: error\ndata: boom\n\n"]));
    const events = await collect(
      streamAgentInvoke("/stream", REQUEST, new AbortController().signal),
    );
    expect(events).toEqual([{ type: "error", data: "boom" }]);
  });

  it("[tag:agent-stream] maps maf token events onto message events", async () => {
    mockFetch(() =>
      streamResponse([
        'event: token\ndata: {"data":"token-text","metadata":{},"timestamp":"2026-01-01T00:00:00Z"}\n\n',
        'event: token\ndata: {"data":{"unexpected":true}}\n\n',
      ]),
    );

    const events = await collect(
      streamAgentInvoke("/stream", REQUEST, new AbortController().signal),
    );

    expect(events).toEqual([
      { type: "message", data: "token-text" },
      { type: "message", data: "" },
    ]);
  });

  it("[tag:agent-stream] maps maf per-agent lifecycle (agent_started / agent_completed)", async () => {
    mockFetch(() =>
      streamResponse([
        'event: agent_started\ndata: {"metadata":{"agentName":"researcher","startedAt":"2026-01-01T00:00:00Z"}}\n\n',
        'event: token\ndata: {"data":"draft","metadata":{"agentName":"researcher"}}\n\n',
        'event: agent_completed\ndata: {"metadata":{"agentName":"researcher","completedAt":"2026-01-01T00:00:01Z","durationMs":812}}\n\n',
        // agentName missing -> dropped (null)
        'event: agent_started\ndata: {"metadata":{}}\n\n',
      ]),
    );

    const events = await collect(
      streamAgentInvoke("/stream", REQUEST, new AbortController().signal),
    );

    expect(events).toEqual([
      {
        type: "agent_started",
        data: { agentName: "researcher", startedAt: "2026-01-01T00:00:00Z" },
      },
      { type: "message", data: "draft" },
      {
        type: "agent_completed",
        data: {
          agentName: "researcher",
          completedAt: "2026-01-01T00:00:01Z",
          durationMs: 812,
        },
      },
    ]);
  });

  it("[tag:agent-stream] maps maf tool-call and tool-result events", async () => {
    mockFetch(() =>
      streamResponse([
        'event: tool_call\ndata: {"data":{"toolCallId":"call-1","toolName":"kb_retrieve","args":{"query":"q"},"member_name":"worker-1","member_id":"mem-1"}}\n\n',
        'event: tool_result\ndata: {"data":{"id":"call-1","result":{"ok":true},"memberName":"worker-1","memberId":"mem-1"}}\n\n',
      ]),
    );

    const events = await collect(
      streamAgentInvoke("/stream", REQUEST, new AbortController().signal),
    );

    expect(events).toEqual([
      {
        type: "tool_call_start",
        data: {
          toolCallId: "call-1",
          toolName: "kb_retrieve",
          args: { query: "q" },
          memberName: "worker-1",
          memberId: "mem-1",
        },
      },
      {
        type: "tool_call_result",
        data: {
          toolCallId: "call-1",
          result: { ok: true },
          memberName: "worker-1",
          memberId: "mem-1",
        },
      },
    ]);
  });

  it("[tag:agent-stream] ignores maf tool-call and tool-result events with non-object payloads", async () => {
    mockFetch(() =>
      streamResponse([
        'event: tool_call\ndata: {"data":"not-an-object"}\n\n',
        'event: tool_result\ndata: {"data":null}\n\n',
      ]),
    );

    const events = await collect(
      streamAgentInvoke("/stream", REQUEST, new AbortController().signal),
    );

    expect(events).toEqual([]);
  });

  it("[tag:agent-stream] maps maf completed payloads into done events with provenance, tool stats, and kb stats", async () => {
    mockFetch(() =>
      streamResponse([
        `event: completed
data: ${JSON.stringify({
  metadata: {
    invokeResponse: {
      sessionId: "session-1",
      durationMs: 2500,
      traceId: "trace-1",
      usage: { inputTokens: 10, outputTokens: 20 },
      citations: {
        respondingAgent: { model: "claude", temperature: 0.2 },
        performance: { totalDurationMs: 5000 },
        kbCitations: [{ knowledgeBaseId: "kb-1", source: "doc-1" }],
        agentTrace: [
          {
            stepIndex: 1,
            agentName: "Planner",
            action: "route",
            input: "hello",
            output: "world",
            durationMs: 50,
            round: 1,
            timestamp: "2026-01-01T00:00:00Z",
            toolExecutions: [
              {
                toolName: "kb_retrieve",
                toolCallId: "call-1",
                arguments: { query: "q" },
                resultSummary: "done",
                durationMs: 100,
                toolType: "kb",
                tokensUsed: 17,
                kbCitations: [
                  { knowledgeBaseId: "kb-1", knowledgeBaseName: "KB One" },
                  { knowledgeBaseId: "kb-1", knowledgeBaseName: "KB One" },
                ],
              },
              {
                toolName: "mcp_tool",
                toolCallId: "call-2",
                durationMs: 25,
                error: "boom",
                toolType: "toolset",
              },
            ],
          },
        ],
      },
    },
  },
})}

`,
      ]),
    );

    const events = await collect(
      streamAgentInvoke("/stream", REQUEST, new AbortController().signal),
    );

    expect(events).toEqual([
      {
        type: "done",
        data: {
          sessionId: "session-1",
          latencyMs: 2500,
          modelName: "claude",
          usage: { inputTokens: 10, outputTokens: 20 },
          citations: [{ knowledgeBaseId: "kb-1", source: "doc-1" }],
          traceId: "trace-1",
          modelConfig: { temperature: 0.2 },
          toolStats: [
            {
              toolName: "kb_retrieve",
              serverName: "",
              serverId: "",
              status: "completed",
              latencyMs: 100,
              toolType: "kb",
            },
            {
              toolName: "mcp_tool",
              serverName: "",
              serverId: "",
              status: "failed",
              latencyMs: 25,
              toolType: "toolset",
            },
          ],
          kbStats: [
            {
              knowledgeBaseId: "kb-1",
              knowledgeBaseName: "KB One",
              retrievedChunks: 2,
              tokensUsed: 17,
            },
          ],
          provenance: {
            respondingAgent: { model: "claude", temperature: 0.2 },
            performance: { totalDurationMs: 5000 },
            agentTrace: [
              {
                stepIndex: 1,
                agentName: "Planner",
                action: "route",
                input: "hello",
                output: "world",
                durationMs: 50,
                round: 1,
                timestamp: "2026-01-01T00:00:00Z",
                toolExecutions: [
                  {
                    toolName: "kb_retrieve",
                    toolCallId: "call-1",
                    arguments: { query: "q" },
                    resultSummary: "done",
                    durationMs: 100,
                    error: undefined,
                    toolType: "kb",
                    tokensUsed: 17,
                    kbCitations: [
                      { knowledgeBaseId: "kb-1", knowledgeBaseName: "KB One" },
                      { knowledgeBaseId: "kb-1", knowledgeBaseName: "KB One" },
                    ],
                  },
                  {
                    toolName: "mcp_tool",
                    toolCallId: "call-2",
                    arguments: undefined,
                    resultSummary: undefined,
                    durationMs: 25,
                    error: "boom",
                    toolType: "toolset",
                    tokensUsed: undefined,
                    kbCitations: null,
                  },
                ],
              },
            ],
          },
        },
      },
    ]);
  });

  it("[tag:agent-stream] falls back to performance timing and omits optional completed fields when absent", async () => {
    mockFetch(() =>
      streamResponse([
        `event: completed
data: ${JSON.stringify({
  metadata: {
    invokeResponse: {
      citations: {
        performance: { totalDurationMs: 77 },
        agentTrace: [
          {
            toolExecutions: [
              {
                toolName: "legacy-kb",
                durationMs: 12,
                kbCitations: [{ knowledgeBaseId: "kb-2", knowledgeBaseName: "KB Two" }],
                tokensUsed: 9,
              },
            ],
          },
        ],
      },
    },
  },
})}

`,
      ]),
    );

    const events = await collect(
      streamAgentInvoke("/stream", REQUEST, new AbortController().signal),
    );

    expect(events).toEqual([
      {
        type: "done",
        data: {
          sessionId: "",
          latencyMs: 77,
          modelName: undefined,
          usage: null,
          citations: null,
          traceId: undefined,
          modelConfig: undefined,
          toolStats: [
            {
              toolName: "legacy-kb",
              serverName: "",
              serverId: "",
              status: "completed",
              latencyMs: 12,
              toolType: undefined,
            },
          ],
          kbStats: [
            {
              knowledgeBaseId: "kb-2",
              knowledgeBaseName: "KB Two",
              retrievedChunks: 1,
              tokensUsed: 9,
            },
          ],
          provenance: {
            respondingAgent: undefined,
            performance: { totalDurationMs: 77 },
            agentTrace: [
              {
                stepIndex: undefined,
                agentName: undefined,
                action: undefined,
                input: undefined,
                output: undefined,
                durationMs: undefined,
                round: undefined,
                timestamp: undefined,
                toolExecutions: [
                  {
                    toolName: "legacy-kb",
                    toolCallId: undefined,
                    arguments: undefined,
                    resultSummary: undefined,
                    durationMs: 12,
                    error: undefined,
                    toolType: undefined,
                    tokensUsed: 9,
                    kbCitations: [{ knowledgeBaseId: "kb-2", knowledgeBaseName: "KB Two" }],
                  },
                ],
              },
            ],
          },
        },
      },
    ]);
  });

  it("[tag:agent-stream] ignores lifecycle events with no UI mapping", async () => {
    mockFetch(() =>
      streamResponse([
        "event: started\ndata: anything\n\n",
        "event: thinking\ndata: anything\n\n",
        "event: artifact\ndata: anything\n\n",
      ]),
    );

    const events = await collect(
      streamAgentInvoke("/stream", REQUEST, new AbortController().signal),
    );

    expect(events).toEqual([]);
  });

  it("[tag:agent-stream] falls back to the raw data line for non-string maf error payloads", async () => {
    mockFetch(() =>
      streamResponse([
        'event: error\ndata: {"data":{"message":"structured"}}\n\n',
      ]),
    );

    const events = await collect(
      streamAgentInvoke("/stream", REQUEST, new AbortController().signal),
    );

    expect(events).toEqual([{ type: "error", data: '{"data":{"message":"structured"}}' }]);
  });

  it("[tag:agent-stream] returns a minimal done payload when completed metadata is absent", async () => {
    mockFetch(() =>
      streamResponse([
        'event: completed\ndata: {"metadata":{}}\n\n',
      ]),
    );

    const events = await collect(
      streamAgentInvoke("/stream", REQUEST, new AbortController().signal),
    );

    expect(events).toEqual([
      {
        type: "done",
        data: {
          sessionId: "",
          latencyMs: undefined,
          modelName: undefined,
          usage: null,
          citations: null,
          traceId: undefined,
          modelConfig: undefined,
          toolStats: undefined,
          kbStats: undefined,
          provenance: undefined,
        },
      },
    ]);
  });

  it("[tag:agent-stream] ignores comment lines and unknown event types", async () => {
    mockFetch(() =>
      streamResponse([
        ": ping\n\n",
        "event: heartbeat\ndata: x\n\n",
        "event: message\ndata: kept\n\n",
      ]),
    );
    const events = await collect(
      streamAgentInvoke("/stream", REQUEST, new AbortController().signal),
    );
    expect(events).toEqual([{ type: "message", data: "kept" }]);
  });

  it("[tag:agent-stream] ignores chunks with no event type or no data lines", async () => {
    mockFetch(() =>
      streamResponse([
        "data: orphan\n\n",
        "event: message\n\n",
      ]),
    );

    const events = await collect(
      streamAgentInvoke("/stream", REQUEST, new AbortController().signal),
    );

    expect(events).toEqual([]);
  });

  it("[tag:agent-stream] drops a terminal event whose JSON payload is malformed", async () => {
    mockFetch(() => streamResponse(["event: done\ndata: {oops\n\n"]));
    const events = await collect(
      streamAgentInvoke("/stream", REQUEST, new AbortController().signal),
    );
    expect(events).toEqual([]);
  });

  it("[tag:agent-stream] flushes a trailing event left in the buffer when the stream closes", async () => {
    mockFetch(() => streamResponse(["event: message\ndata: tail"]));
    const events = await collect(
      streamAgentInvoke("/stream", REQUEST, new AbortController().signal),
    );
    expect(events).toEqual([{ type: "message", data: "tail" }]);
  });

  it("[tag:agent-stream] throws on a non-ok response", async () => {
    mockFetch(() => streamResponse([], { ok: false, status: 500 }));
    await expect(
      collect(streamAgentInvoke("/stream", REQUEST, new AbortController().signal)),
    ).rejects.toThrow("HTTP 500");
  });

  it("[tag:agent-stream] surfaces a JSON detail string from non-ok responses", async () => {
    mockFetch(() =>
      streamResponse([], {
        ok: false,
        status: 413,
        text: JSON.stringify({ detail: "Prompt exceeds model context window" }),
      }),
    );

    await expect(
      collect(streamAgentInvoke("/stream", REQUEST, new AbortController().signal)),
    ).rejects.toThrow("Prompt exceeds model context window");
  });

  it("[tag:agent-stream] surfaces plain-text non-ok response bodies", async () => {
    mockFetch(() =>
      streamResponse([], {
        ok: false,
        status: 502,
        text: "Bad gateway",
      }),
    );

    await expect(
      collect(streamAgentInvoke("/stream", REQUEST, new AbortController().signal)),
    ).rejects.toThrow("Bad gateway");
  });

  it("[tag:agent-stream] throws when the response has no body", async () => {
    mockFetch(() => streamResponse([], { withBody: false }));
    await expect(
      collect(streamAgentInvoke("/stream", REQUEST, new AbortController().signal)),
    ).rejects.toThrow("HTTP 200");
  });

  it("[tag:agent-stream] swallows fetch rejection when the request was aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    mockFetch(() => Promise.reject(new Error("aborted")));
    const events = await collect(
      streamAgentInvoke("/stream", REQUEST, controller.signal),
    );
    expect(events).toEqual([]);
  });

  it("[tag:agent-stream] rethrows fetch rejection that is not an abort", async () => {
    mockFetch(() => Promise.reject(new Error("network down")));
    await expect(
      collect(streamAgentInvoke("/stream", REQUEST, new AbortController().signal)),
    ).rejects.toThrow("network down");
  });
});
