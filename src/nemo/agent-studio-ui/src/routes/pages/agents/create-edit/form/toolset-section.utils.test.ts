import { describe, expect, it } from "vitest";

import type { ToolsetOption } from "../configure-dialogs/configure-dialogs.types";
import type { AgentAttachedToolset } from "./agent-form.consts";
import { buildAttachedToolset, enrichWithCatalog } from "./toolset-section.utils";

const CATALOG: ToolsetOption[] = [
  {
    id: "ts-1",
    name: "GitHub",
    status: "healthy",
    labels: ["prod"],
    authType: "OAuth",
    tools: [
      { id: "search", name: "search", description: "" },
      { id: "create", name: "create", description: "" },
    ],
  },
  {
    id: "ts-2",
    name: "Calc",
    status: "degraded",
    labels: ["staging"],
    tools: [{ id: "add", name: "add", description: "" }],
  },
  {
    id: "ts-3",
    name: "Broken",
    status: "unknown",
    labels: [],
    tools: [],
  },
];

describe("toolset-section.utils", () => {
  it("buildAttachedToolset returns null when the draft id is not in the catalog", () => {
    expect(
      buildAttachedToolset({ toolsetId: "missing", selectedToolIds: [] }, CATALOG),
    ).toBeNull();
  });

  it("buildAttachedToolset maps selected tools and status from the catalog", () => {
    expect(
      buildAttachedToolset({ toolsetId: "ts-1", selectedToolIds: ["search"] }, CATALOG),
    ).toEqual({
      id: "ts-1",
      name: "GitHub",
      status: "healthy",
      account: "GitHub",
      authMethod: "OAuth",
      tools: ["search"],
    });
  });

  it("buildAttachedToolset falls back to labels when authType is missing", () => {
    const attached = buildAttachedToolset(
      { toolsetId: "ts-2", selectedToolIds: ["add"] },
      CATALOG,
    );
    expect(attached?.status).toBe("degraded");
    expect(attached?.authMethod).toBe("staging");
  });

  it("enrichWithCatalog returns the attached toolset when the id is missing from the catalog", () => {
    const attached: AgentAttachedToolset = {
      id: "orphan",
      name: "Orphan",
      status: "healthy",
      account: "acct",
      authMethod: "token",
      tools: ["one"],
    };
    expect(enrichWithCatalog(attached, CATALOG)).toBe(attached);
  });

  it("enrichWithCatalog refreshes metadata and keeps attached tools when present", () => {
    const attached: AgentAttachedToolset = {
      id: "ts-1",
      name: "Old name",
      status: "unhealthy",
      account: "old",
      authMethod: "old",
      tools: ["search"],
    };
    expect(enrichWithCatalog(attached, CATALOG)).toEqual({
      id: "ts-1",
      name: "GitHub",
      status: "healthy",
      account: "GitHub",
      authMethod: "OAuth",
      tools: ["search"],
    });
  });

  it("enrichWithCatalog uses catalog tool names when the attached toolset has none", () => {
    const attached: AgentAttachedToolset = {
      id: "ts-2",
      name: "Calc",
      status: "degraded",
      account: "Calc",
      authMethod: "staging",
      tools: [],
    };
    expect(enrichWithCatalog(attached, CATALOG).tools).toEqual(["add"]);
  });
});
