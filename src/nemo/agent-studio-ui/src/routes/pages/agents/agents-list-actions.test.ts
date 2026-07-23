import type { MouseEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import { buildActionMenu } from "./agents-list-actions";
import type { AgentTableRow } from "./columns/agents-list.columns";
import { AGENTS_LIST_STRINGS, DEPLOY_LOCKED_CLASS } from "./agents.consts";

/** Builds a fake click event whose currentTarget optionally carries the lock marker. */
const clickEventOn = (locked: boolean): MouseEvent<HTMLElement> => {
  const el = document.createElement("div");
  if (locked) el.className = DEPLOY_LOCKED_CLASS;
  return { currentTarget: el } as unknown as MouseEvent<HTMLElement>;
};

const makeRow = (overrides: Partial<AgentTableRow> = {}): AgentTableRow => ({
  id: "ag-1",
  name: "Test Agent",
  status: "Healthy",
  models: [],
  lastUpdated: "2026-02-01T00:00:00Z",
  deploymentStatus: "draft",
  associatedResources: [],
  associatedItems: [],
  teamDependencyCount: 0,
  ...overrides,
});

const makeDeps = (overrides = {}) => ({
  navigate: vi.fn(),
  isDeprecated: vi.fn(() => false),
  // deprecate: vi.fn(),
  // undeprecate: vi.fn(),
  onRequestDelete: vi.fn(),
  deploy: vi.fn(),
  draft: vi.fn(),
  ...overrides,
});

describe("buildActionMenu", () => {
  describe("[tag:agents] deprecated row", () => {
    it("returns a view-only menu without undeprecate action", () => {
      const deps = makeDeps({ isDeprecated: vi.fn(() => true) });
      const menu = buildActionMenu(makeRow(), deps);
      const labels = menu.map((i) => i.label);
      expect(labels).toContain(AGENTS_LIST_STRINGS.ACTION_VIEW_DETAILS);
      expect(labels).not.toContain(AGENTS_LIST_STRINGS.ACTION_UNDEPRECATE);
    });

    it("disables edit and delete for deprecated rows", () => {
      const deps = makeDeps({ isDeprecated: vi.fn(() => true) });
      const menu = buildActionMenu(makeRow(), deps);
      const edit = menu.find((i) => i.label === AGENTS_LIST_STRINGS.ACTION_EDIT);
      const del = menu.find((i) => i.label === AGENTS_LIST_STRINGS.ACTION_DELETE);
      expect(edit?.isDisabled).toBe(true);
      expect(del?.isDisabled).toBe(true);
    });
  });

  describe("[tag:agents] deployed row", () => {
    it("omits deprecate action and disables edit", () => {
      const deps = makeDeps();
      const menu = buildActionMenu(makeRow({ deploymentStatus: "deployed" }), deps);
      const labels = menu.map((i) => i.label);
      expect(labels).not.toContain(AGENTS_LIST_STRINGS.ACTION_DEPRECATE);
      const edit = menu.find((i) => i.label === AGENTS_LIST_STRINGS.ACTION_EDIT);
      expect(edit?.isDisabled).toBe(true);
    });

    it("view details navigates to the agent detail path", () => {
      const deps = makeDeps();
      const row = makeRow({ id: "ag-4", deploymentStatus: "deployed" });
      const menu = buildActionMenu(row, deps);
      const item = menu.find((i) => i.label === AGENTS_LIST_STRINGS.ACTION_VIEW_DETAILS)!;
      item.onClick(row);
      expect(deps.navigate).toHaveBeenCalledWith(expect.stringContaining("ag-4"));
    });
  });

  describe("[tag:agents] draft row", () => {
    it("includes edit and locked deploy while LOCK_AGENT_DEPLOY is true", () => {
      const deps = makeDeps();
      const menu = buildActionMenu(makeRow({ deploymentStatus: "draft" }), deps);
      const labels = menu.map((i) => i.label);
      expect(labels).toContain(AGENTS_LIST_STRINGS.ACTION_EDIT);
      const deployItem = menu.find((i) => i.label === AGENTS_LIST_STRINGS.ACTION_DEPLOY)!;
      expect(deployItem).toBeDefined();
      expect(deployItem.className).toBe(DEPLOY_LOCKED_CLASS);
      // Intentionally not the framework `disabled` prop (that would sever
      // onClick and break devtools testability); locked via aria-disabled +
      // the JS activation guard instead.
      expect(deployItem.isDisabled).toBeUndefined();
      expect(deployItem.ariaDisabled).toBe(true);
    });

    it("locked Deploy onClick is a no-op until the --locked marker is removed (JS guard)", () => {
      const deps = makeDeps();
      const row = makeRow({ deploymentStatus: "draft" });
      const deployItem = buildActionMenu(row, deps).find(
        (i) => i.label === AGENTS_LIST_STRINGS.ACTION_DEPLOY,
      )!;

      // Keyboard/programmatic activation while locked: guard blocks the deploy.
      deployItem.onClick(row, clickEventOn(true));
      expect(deps.deploy).not.toHaveBeenCalled();

      // Marker removed in devtools -> guard releases and deploy fires.
      deployItem.onClick(row, clickEventOn(false));
      expect(deps.deploy).toHaveBeenCalledWith(row);
    });

    it("locked Deploy still respects blocking requirements even after the marker is removed", () => {
      const deps = makeDeps();
      const row = makeRow({ deploymentStatus: "draft", hasBlockingRequirements: true });
      const deployItem = buildActionMenu(row, deps).find(
        (i) => i.label === AGENTS_LIST_STRINGS.ACTION_DEPLOY,
      )!;

      // Devtools-unlock lifts only the lock; the requirements gate must still
      // block the deploy when the row has an unresolved required KB/MCP.
      deployItem.onClick(row, clickEventOn(false));
      expect(deps.deploy).not.toHaveBeenCalled();
    });

    it("delete is disabled when the row has team dependencies", () => {
      const deps = makeDeps();
      const menu = buildActionMenu(makeRow({ teamDependencyCount: 1 }), deps);
      const del = menu.find((i) => i.label === AGENTS_LIST_STRINGS.ACTION_DELETE)!;
      expect(del.isDisabled).toBe(true);
    });

    it("delete is enabled when only non-team associations exist", () => {
      const deps = makeDeps();
      const menu = buildActionMenu(
        makeRow({
          associatedItems: [{ id: "kb-1", name: "KB", kind: "knowledge-base" }],
          teamDependencyCount: 0,
        }),
        deps,
      );
      const del = menu.find((i) => i.label === AGENTS_LIST_STRINGS.ACTION_DELETE)!;
      expect(del.isDisabled).toBeFalsy();
    });

    it("delete calls onRequestDelete when not associated", () => {
      const deps = makeDeps();
      const row = makeRow({ id: "ag-5", name: "My Agent", associatedItems: [] });
      const menu = buildActionMenu(row, deps);
      const del = menu.find((i) => i.label === AGENTS_LIST_STRINGS.ACTION_DELETE)!;
      del.onClick(row);
      expect(deps.onRequestDelete).toHaveBeenCalledWith({ id: "ag-5", name: "My Agent" });
    });
  });
});
