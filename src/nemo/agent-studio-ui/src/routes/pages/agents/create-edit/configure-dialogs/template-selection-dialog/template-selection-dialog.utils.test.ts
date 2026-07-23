import { describe, expect, it } from "vitest";

import type { AgentTemplateDefinition } from "../../form/agent-templates.consts";

import {
  filterAndSortTemplates,
  nextTemplateSortState,
} from "./template-selection-dialog.utils";

const TEMPLATES: AgentTemplateDefinition[] = [
  {
    id: "tmpl-b",
    name: "Beta Template",
    description: "Second description",
    capabilities: ["Toolsets"],
    examples: [{ title: "Ex", scenario: "S", response: "R" }],
    instructions: "Beta instructions",
    orchestrationPattern: "Route",
    model: "GPT-4.1",
    role: "manager-b",
    agents: [],
  },
  {
    id: "tmpl-a",
    name: "Alpha Template",
    description: "First description",
    capabilities: ["Knowledge bases"],
    examples: [],
    instructions: "Alpha instructions",
    orchestrationPattern: "Sequential",
    model: "Claude",
    role: "manager-a",
    agents: [],
  },
];

describe("template-selection-dialog.utils", () => {
  it("filters templates by search text", () => {
    const result = filterAndSortTemplates(TEMPLATES, "alpha", null, "asc");
    expect(result.map((template) => template.id)).toEqual(["tmpl-a"]);
  });

  it("sorts templates by name ascending and descending", () => {
    const asc = filterAndSortTemplates(TEMPLATES, "", "name", "asc");
    expect(asc.map((template) => template.id)).toEqual(["tmpl-a", "tmpl-b"]);

    const desc = filterAndSortTemplates(TEMPLATES, "", "name", "desc");
    expect(desc.map((template) => template.id)).toEqual(["tmpl-b", "tmpl-a"]);
  });

  it("sorts examples by count", () => {
    const asc = filterAndSortTemplates(TEMPLATES, "", "examples", "asc");
    expect(asc.map((template) => template.id)).toEqual(["tmpl-a", "tmpl-b"]);
  });

  it("cycles sort state asc → desc → cleared", () => {
    expect(nextTemplateSortState(null, "asc", "name")).toEqual({
      sortKey: "name",
      sortDirection: "asc",
    });
    expect(nextTemplateSortState("name", "asc", "name")).toEqual({
      sortKey: "name",
      sortDirection: "desc",
    });
    expect(nextTemplateSortState("name", "desc", "name")).toEqual({
      sortKey: null,
      sortDirection: "asc",
    });
  });
});
