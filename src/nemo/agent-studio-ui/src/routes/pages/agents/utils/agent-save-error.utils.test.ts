import { describe, expect, it } from "vitest";

import {
  formatAgentSaveErrorMessage,
  formatUnmetRequirementsMessage,
  parseUnmetRequirements,
} from "./agent-save-error.utils";

describe("parseUnmetRequirements", () => {
  it("[tag:agent-save-error] parses unmetRequirements from an RTK Query 400 rejection", () => {
    const error = {
      status: 400,
      data: {
        error: "Cannot transition to deployed: required resource placeholders remain unresolved",
        unmetRequirements: [
          { kind: "knowledgeBases", id: "kb-1", label: "Internal docs" },
          { kind: "mcpServers", id: "mcp-1", label: "GitHub MCP" },
        ],
      },
    };

    expect(parseUnmetRequirements(error)).toEqual([
      { kind: "knowledgeBases", id: "kb-1", label: "Internal docs" },
      { kind: "mcpServers", id: "mcp-1", label: "GitHub MCP" },
    ]);
  });

  it("[tag:agent-save-error] ignores malformed entries and non-array payloads", () => {
    expect(parseUnmetRequirements(null)).toEqual([]);
    expect(parseUnmetRequirements({ status: 400, data: {} })).toEqual([]);
    expect(
      parseUnmetRequirements({
        status: 400,
        data: {
          unmetRequirements: [
            { kind: "invalid", id: "x", label: "Bad" },
            { kind: "knowledgeBases", id: "", label: "Empty id" },
            { kind: "mcpServers", id: "mcp-1", label: "Valid MCP" },
          ],
        },
      }),
    ).toEqual([{ kind: "mcpServers", id: "mcp-1", label: "Valid MCP" }]);
  });
});

describe("formatUnmetRequirementsMessage", () => {
  it("[tag:agent-save-error] formats labels with human-readable resource kinds", () => {
    expect(
      formatUnmetRequirementsMessage([
        { kind: "knowledgeBases", id: "kb-1", label: "Internal docs" },
        { kind: "mcpServers", id: "mcp-1", label: "GitHub MCP" },
      ]),
    ).toBe(
      "Configure required resources before deploying: Internal docs (knowledge base), GitHub MCP (toolset).",
    );
  });
});

describe("formatAgentSaveErrorMessage", () => {
  const unmetError = {
    status: 400,
    data: {
      unmetRequirements: [
        { kind: "knowledgeBases", id: "kb-1", label: "Internal docs" },
      ],
    },
  };

  it("[tag:agent-save-error] prefers actionable unmetRequirements copy over generic save failure", () => {
    expect(
      formatAgentSaveErrorMessage(unmetError, {
        agentName: "Support agent",
        saveSucceeded: false,
      }),
    ).toBe(
      "Configure required resources before deploying: Internal docs (knowledge base).",
    );
  });

  it("[tag:agent-save-error] reports deploy failure after a successful save", () => {
    expect(
      formatAgentSaveErrorMessage(
        { status: 500, data: { error: "Service unavailable" } },
        { agentName: "Support agent", saveSucceeded: true },
      ),
    ).toBe(
      "Saved Support agent as draft, but deploy failed. Service unavailable",
    );
  });

  it("[tag:agent-save-error] uses deploy-specific fallback when deploy fails with status only", () => {
    expect(
      formatAgentSaveErrorMessage(
        { status: 500, data: {} },
        { agentName: "Support agent", saveSucceeded: true },
      ),
    ).toBe(
      "Saved Support agent as draft, but deploy failed. Deploy failed. Please try again. (HTTP 500)",
    );
  });

  it("[tag:agent-save-error] surfaces backend error text for non-unmet save failures", () => {
    expect(
      formatAgentSaveErrorMessage(
        { status: 409, data: { error: "Agent with this name already exists" } },
        { agentName: "Support agent", saveSucceeded: false },
      ),
    ).toBe("Failed to save Support agent. Agent with this name already exists");
  });

  it("[tag:agent-save-error] falls back to generic copy when no details are available", () => {
    expect(
      formatAgentSaveErrorMessage(new Error("boom"), {
        agentName: "Support agent",
        saveSucceeded: false,
      }),
    ).toBe("Failed to save Support agent. boom");
  });
});
