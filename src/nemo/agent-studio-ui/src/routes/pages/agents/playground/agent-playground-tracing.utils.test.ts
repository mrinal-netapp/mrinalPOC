import { describe, expect, it } from "vitest";

import type {
  AgentSessionMessage,
  AgentStreamProvenance,
  AgentTraceSpan,
} from "@/routes/pages/agents/api/agents.types";
import {
  buildTraceStatistics,
  buildTracingStepsFromProvenance,
  buildTracingStepsFromSpans,
  findLatestAssistantTraceId,
  flattenTraceSpans,
  getSpanAttributeText,
  getSpanDurationMs,
  isTraceStepSpanKind,
} from "./agent-playground-tracing.utils";

const traceSpans: AgentTraceSpan[] = [
  {
    id: "root",
    name: "agent.invoke",
    context: { span_id: "root-span" },
    parent_id: null,
    span_kind: "UNKNOWN",
    start_time: "2026-05-19T10:00:00.000Z",
    end_time: "2026-05-19T10:00:03.000Z",
  },
  {
    id: "child-1",
    name: "Agent.arun",
    context: { span_id: "child-1-span" },
    parent_id: "root-span",
    span_kind: "AGENT",
    start_time: "2026-05-19T10:00:00.500Z",
    end_time: "2026-05-19T10:00:01.000Z",
    attributes: {
      "input.value": "hello",
      "output.value": "{\"ok\":true}",
    },
  },
  {
    id: "child-2",
    name: "llm.call",
    context: { span_id: "child-2-span" },
    parent_id: "root-span",
    span_kind: "LLM",
    start_time: "2026-05-19T10:00:01.100Z",
    end_time: "2026-05-19T10:00:02.600Z",
    attributes: { "llm.model_name": "gpt-4o-mini" },
  },
];

describe("agent-playground-tracing.utils", () => {
  it("[tag:agents] calculates span durations from timestamps", () => {
    expect(getSpanDurationMs(traceSpans[0])).toBe(3000);
    expect(getSpanDurationMs({ id: "broken", name: "broken" })).toBeNull();
  });

  it("[tag:agents] flattens spans into a parent-child ordered list", () => {
    const flattened = flattenTraceSpans(traceSpans);
    expect(flattened.map((item) => item.span.id)).toEqual(["root", "child-1", "child-2"]);
    expect(flattened.map((item) => item.depth)).toEqual([0, 1, 1]);
  });

  it("[tag:agents] filters trace steps by span kind and maps io attributes", () => {
    expect(isTraceStepSpanKind("AGENT")).toBe(true);
    expect(isTraceStepSpanKind("unknown")).toBe(false);

    const steps = buildTracingStepsFromSpans(traceSpans);
    expect(steps.map((step) => step.name)).toEqual(["Agent.arun", "llm.call"]);
    expect(steps[0]?.spanKind).toBe("AGENT");
    expect(steps[0]?.durationMs).toBe(500);
    expect(steps[0]?.input).toBe("hello");
    expect(steps[0]?.output).toBe('{\n  "ok": true\n}');
    expect(getSpanAttributeText({ "input.value": "  " }, "input.value")).toBeNull();
  });

  it("[tag:agents] finds the latest assistant trace id from session messages", () => {
    const messages: AgentSessionMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "first", traceId: "trace-1" },
      { role: "assistant", content: "second", traceId: "trace-2" },
    ];
    expect(findLatestAssistantTraceId(messages)).toBe("trace-2");
  });

  it("[tag:agents] builds statistics from run metrics and spans", () => {
    const stats = buildTraceStatistics(
      {
        sessionId: "session-1",
        usage: {
          promptTokens: 11,
          completionTokens: 7,
          totalTokens: 18,
        },
      },
      traceSpans,
    );

    expect(stats.modelName).toBe("gpt-4o-mini");
    expect(stats.totalSpanDurationMs).toBe(3000);
    expect(stats.spanCount).toBe(3);
    expect(stats.usage?.totalTokens).toBe(18);
  });
});

describe("buildTracingStepsFromProvenance", () => {
  it("[tag:agents] returns [] when provenance has no agent trace", () => {
    expect(buildTracingStepsFromProvenance(undefined)).toEqual([]);
    expect(buildTracingStepsFromProvenance({})).toEqual([]);
    expect(buildTracingStepsFromProvenance({ agentTrace: [] })).toEqual([]);
  });

  it("[tag:agents] renders an AGENT row per step with TOOL rows for tool executions", () => {
    const provenance: AgentStreamProvenance = {
      agentTrace: [
        {
          agentName: "Weather-App",
          action: "respond",
          durationMs: 9556,
          output: "the answer",
          toolExecutions: [
            {
              toolName: "geocoding",
              toolCallId: "c1",
              arguments: { q: "SF" },
              resultSummary: "ok",
              durationMs: 2,
            },
            {
              toolName: "forecast",
              resultSummary: "ERROR: upstream 503",
              durationMs: 5,
            },
          ],
        },
      ],
    };

    const steps = buildTracingStepsFromProvenance(provenance);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatchObject({ spanKind: "AGENT", name: "Weather-App · respond", output: "the answer" });
    expect(steps[1]).toMatchObject({ spanKind: "TOOL", name: "geocoding", output: "ok" });
    // A failed tool execution is labelled and surfaces its error as output.
    expect(steps[2]).toMatchObject({ spanKind: "TOOL", name: "forecast (failed)" });
    expect(steps[2].output).toContain("ERROR: upstream 503");
  });
});
