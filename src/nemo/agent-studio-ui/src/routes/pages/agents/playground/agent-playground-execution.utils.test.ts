import { describe, expect, it } from "vitest";

import {
  buildExecutionStepsFromAgentTrace,
  parseKbRetrievalDetails,
} from "./agent-playground-execution.utils";

const exampleResult = [
  {
    title: "proj7l50k5do.azure-mysql",
    content:
      "<kb_data>\ntitle: LIBERTY MAGNIFICENT\ndescription: A Boring Drama of a Student And a Cat who must Sink a Technical Writer in A Baloon\nrelease_year: 2006\n</kb_data>",
    score: 1.0,
    knowledge_base_id: "kba64shx73",
  },
  {
    title: "proj7l50k5do.azure-mysql",
    content:
      "<kb_data>\ntitle: CARIBBEAN LIBERTY\ndescription: A Fanciful Tale of a Pioneer And a Technical Writer who must Outgun a Pioneer in A Shark Tank\nrelease_year: 2006\n</kb_data>",
    score: 0.9684979838709676,
    knowledge_base_id: "kba64shx73",
  },
];

describe("agent-playground-execution.utils", () => {
  it("[tag:agents] maps knowledge base retrieval fields from start args and result array", () => {
    const details = parseKbRetrievalDetails(
      { query: "LIBERTY MAGNIFICENT movie" },
      exampleResult,
    );

    expect(details?.knowledgeBaseId).toBe("kba64shx73");
    expect(details?.query).toBe("LIBERTY MAGNIFICENT movie");
    expect(details?.topKLabel).toBe("2 chunks");
    expect(details?.totalContextLabel).toMatch(/tokens$/);
    expect(details?.chunks[0]).toMatchObject({
      fileLabel: "LIBERTY MAGNIFICENT",
      path: "proj7l50k5do.azure-mysql",
      scoreLabel: "100%",
    });
    expect(details?.chunks[1]).toMatchObject({
      fileLabel: "CARIBBEAN LIBERTY",
      scoreLabel: "97%",
    });
  });

  it("[tag:agents] reads query from tool_call_start args while result is pending", () => {
    const details = parseKbRetrievalDetails({ query: "LIBERTY MAGNIFICENT movie" }, undefined);

    expect(details).toEqual({
      knowledgeBaseId: undefined,
      topKLabel: undefined,
      totalContextLabel: undefined,
      query: "LIBERTY MAGNIFICENT movie",
      chunks: [],
      logs: undefined,
    });
  });

  it("[tag:agents] keeps query from args when merging tool_call_result payload", () => {
    const details = parseKbRetrievalDetails(
      { query: "LIBERTY MAGNIFICENT movie" },
      exampleResult,
    );

    expect(details?.query).toBe("LIBERTY MAGNIFICENT movie");
  });

  it("[tag:agents] reads chunks when tool result is wrapped in tool_call_result payload", () => {
    const details = parseKbRetrievalDetails(
      { query: "test" },
      {
        toolCallId: "call-1",
        result: [{ title: "source-path", content: "title: Chunk A", score: 0.5, knowledge_base_id: "kb-1" }],
      },
    );

    expect(details?.knowledgeBaseId).toBe("kb-1");
    expect(details?.chunks).toEqual([
      {
        fileLabel: "Chunk A",
        path: "source-path",
        scoreLabel: "50%",
        tokensLabel: expect.stringMatching(/tokens$/),
      },
    ]);
  });
});

describe("buildExecutionStepsFromAgentTrace", () => {
  it("[tag:agents] returns [] for empty/missing agent trace", () => {
    expect(buildExecutionStepsFromAgentTrace(undefined)).toEqual([]);
    expect(buildExecutionStepsFromAgentTrace([])).toEqual([]);
    expect(buildExecutionStepsFromAgentTrace([{ agentName: "a", action: "respond" }])).toEqual([]);
  });

  it("[tag:agents] flattens toolExecutions across steps into completed/failed steps", () => {
    const steps = buildExecutionStepsFromAgentTrace([
      {
        agentName: "Weather-App",
        action: "respond",
        toolExecutions: [
          {
            toolName: "geocoding",
            toolCallId: "call-1",
            arguments: { q: "SF" },
            resultSummary: "{...}",
            durationMs: 2,
          },
          {
            toolName: "forecast",
            arguments: { lat: 1 },
            resultSummary: "ERROR: upstream 503",
            durationMs: 5,
          },
        ],
      },
    ]);

    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      toolCallId: "call-1",
      toolName: "geocoding",
      status: "completed",
      elapsedMs: 2,
    });
    // Missing toolCallId is synthesised; ERROR: result marks the step failed.
    expect(steps[1]).toMatchObject({
      toolCallId: "forecast-0-1",
      toolName: "forecast",
      status: "failed",
      elapsedMs: 5,
    });
    expect(steps[1].errorMessage).toContain("ERROR: upstream 503");
  });

  it("[tag:agents] marks a step failed when an explicit error field is present", () => {
    const steps = buildExecutionStepsFromAgentTrace([
      {
        toolExecutions: [
          { toolName: "geocoding", toolCallId: "c1", error: "ConnectionError: refused" },
        ],
      },
    ]);
    expect(steps[0].status).toBe("failed");
    expect(steps[0].errorMessage).toBe("ConnectionError: refused");
  });
});
