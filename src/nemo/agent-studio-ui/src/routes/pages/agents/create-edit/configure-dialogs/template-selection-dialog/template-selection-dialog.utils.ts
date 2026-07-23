import type { AgentTemplateDefinition } from "../../form/agent-templates.consts";

export type TemplateSortDirection = "asc" | "desc";

export type TemplateSortKey =
  | "name"
  | "description"
  | "capabilities"
  | "examples"
  | "instructions";

function templateSearchText(template: AgentTemplateDefinition): string {
  return [
    template.name,
    template.description,
    template.instructions,
    template.capabilities.join(" "),
  ]
    .join(" ")
    .toLowerCase();
}

function sortValue(
  template: AgentTemplateDefinition,
  key: TemplateSortKey,
): string | number {
  switch (key) {
    case "name":
      return template.name;
    case "description":
      return template.description;
    case "capabilities":
      return template.capabilities.join(", ");
    case "examples":
      return template.examples.length;
    case "instructions":
      return template.instructions;
  }
}

/** Templates flagged `hidden` are reserved for a later phase and never shown. */
export function visibleTemplateCatalog(
  templates: readonly AgentTemplateDefinition[],
): AgentTemplateDefinition[] {
  return templates.filter((template) => !template.hidden);
}

export function filterAndSortTemplates(
  templates: readonly AgentTemplateDefinition[],
  search: string,
  sortKey: TemplateSortKey | null,
  sortDirection: TemplateSortDirection,
): AgentTemplateDefinition[] {
  const catalog = visibleTemplateCatalog(templates);
  const trimmed = search.trim().toLowerCase();
  const filtered = trimmed
    ? catalog.filter((template) => templateSearchText(template).includes(trimmed))
    : catalog;

  if (sortKey === null) {
    return filtered;
  }

  const sign = sortDirection === "asc" ? 1 : -1;
  return [...filtered].sort((left, right) => {
    const leftValue = sortValue(left, sortKey);
    const rightValue = sortValue(right, sortKey);

    if (typeof leftValue === "number" && typeof rightValue === "number") {
      return sign * (leftValue - rightValue);
    }

    return sign * String(leftValue).localeCompare(String(rightValue));
  });
}

export function nextTemplateSortState(
  currentKey: TemplateSortKey | null,
  currentDirection: TemplateSortDirection,
  nextKey: TemplateSortKey,
): { sortKey: TemplateSortKey | null; sortDirection: TemplateSortDirection } {
  if (currentKey !== nextKey) {
    return { sortKey: nextKey, sortDirection: "asc" };
  }
  if (currentDirection === "asc") {
    return { sortKey: nextKey, sortDirection: "desc" };
  }
  return { sortKey: null, sortDirection: "asc" };
}
