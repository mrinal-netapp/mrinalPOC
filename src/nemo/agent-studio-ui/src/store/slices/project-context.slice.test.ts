import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { projectContextSlice, setActiveProject, setActiveProjectName, setActiveProjectRole } from "./project-context.slice";

describe("projectContextSlice", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("[tag:project-context] setActiveProject updates id, name, and storage", () => {
    const nextState = projectContextSlice.reducer(
      projectContextSlice.getInitialState(),
      setActiveProject({ id: "proj-1", name: "Team A", role: "admin" }),
    );

    expect(nextState.activeProject.id).toBe("proj-1");
    expect(nextState.activeProject.name).toBe("Team A");
    expect(nextState.activeProject.role).toBe("admin");
    const stored = JSON.parse(localStorage.getItem("agent-studio.active-project") ?? "{}");
    expect(stored.id).toBe("proj-1");
  });

  it("[tag:project-context] setActiveProject with empty id removes the stored key", () => {
    localStorage.setItem("agent-studio.active-project", JSON.stringify({ id: "proj-old", name: "Old", role: null }));

    projectContextSlice.reducer(
      projectContextSlice.getInitialState(),
      setActiveProject({ id: "", name: "" }),
    );

    expect(localStorage.getItem("agent-studio.active-project")).toBeNull();
  });

  it("[tag:project-context] setActiveProjectName updates display name only", () => {
    const state = projectContextSlice.reducer(
      projectContextSlice.getInitialState(),
      setActiveProjectName("Resolved name"),
    );

    expect(state.activeProject.name).toBe("Resolved name");
  });

  it("[tag:project-context] does not label a configured project as local dev", async () => {
    localStorage.setItem("agent-studio.active-project-id", "proj-1");
    vi.resetModules();

    const { projectContextSlice: reloadedSlice } = await import("./project-context.slice");

    expect(reloadedSlice.getInitialState()).toMatchObject({
      activeProject: {
        id: "proj-1",
        name: "",
        role: null,
      },
    });
  });

  it("[tag:project-context] keeps production empty when no project is configured", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_PROJECT_ID", "");
    vi.resetModules();

    const { projectContextSlice: reloadedSlice } = await import("./project-context.slice");

    expect(reloadedSlice.getInitialState()).toMatchObject({
      activeProject: {
        id: "",
        name: "",
        role: null,
      },
    });
  });

  it("[tag:project-context] falls back to an empty active project when localStorage.getItem throws", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_PROJECT_ID", "");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    vi.resetModules();

    const { projectContextSlice: reloadedSlice } = await import("./project-context.slice");

    expect(reloadedSlice.getInitialState()).toMatchObject({
      activeProject: { id: "", name: "", role: null },
    });
  });

  it("[tag:project-context] write is silently ignored when localStorage.setItem throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });

    // Should not throw even when storage write fails.
    expect(() =>
      projectContextSlice.reducer(
        projectContextSlice.getInitialState(),
        setActiveProject({ id: "proj-1", name: "Team A" }),
      ),
    ).not.toThrow();
  });

  it("[tag:project-context] setActiveProject clears the role when none is provided", () => {
    const seeded = projectContextSlice.reducer(
      projectContextSlice.getInitialState(),
      setActiveProject({ id: "proj-1", name: "A", role: "admin" }),
    );

    const next = projectContextSlice.reducer(
      seeded,
      setActiveProject({ id: "proj-2", name: "B" }),
    );

    expect(next.activeProject.role).toBeNull();
  });

  it("[tag:project-context] setActiveProjectRole updates only the role and persists", () => {
    const seeded = projectContextSlice.reducer(
      projectContextSlice.getInitialState(),
      setActiveProject({ id: "proj-1", name: "Team A", role: "admin" }),
    );

    const next = projectContextSlice.reducer(seeded, setActiveProjectRole("member"));

    expect(next.activeProject.id).toBe("proj-1");
    expect(next.activeProject.name).toBe("Team A");
    expect(next.activeProject.role).toBe("member");
    const stored = JSON.parse(localStorage.getItem("agent-studio.active-project") ?? "{}");
    expect(stored.role).toBe("member");
  });

  it("[tag:project-context] setActiveProjectRole can clear the role", () => {
    const seeded = projectContextSlice.reducer(
      projectContextSlice.getInitialState(),
      setActiveProject({ id: "proj-1", name: "Team A", role: "admin" }),
    );

    const next = projectContextSlice.reducer(seeded, setActiveProjectRole(null));

    expect(next.activeProject.role).toBeNull();
  });

  it("[tag:project-context] hydrates a valid stored project including its role", async () => {
    localStorage.setItem(
      "agent-studio.active-project",
      JSON.stringify({ id: "proj-9", name: "Stored", role: "admin" }),
    );
    vi.resetModules();

    const { projectContextSlice: reloadedSlice } = await import("./project-context.slice");

    expect(reloadedSlice.getInitialState()).toMatchObject({
      activeProject: { id: "proj-9", name: "Stored", role: "admin" },
    });
  });

  it("[tag:project-context] sanitizes a corrupt stored project: non-string id/name and unknown role fall back", async () => {
    localStorage.setItem(
      "agent-studio.active-project",
      JSON.stringify({ id: 123, name: { nested: true }, role: "super-admin" }),
    );
    vi.resetModules();

    const { projectContextSlice: reloadedSlice } = await import("./project-context.slice");

    expect(reloadedSlice.getInitialState()).toMatchObject({
      activeProject: { id: "", name: "", role: null },
    });
  });

  it("[tag:project-context] migrates the legacy id+role keys, keeping a known role", async () => {
    localStorage.setItem("agent-studio.active-project-id", "proj-legacy");
    localStorage.setItem("agent-studio.active-project-role", "admin");
    vi.resetModules();

    const { projectContextSlice: reloadedSlice } = await import("./project-context.slice");

    expect(reloadedSlice.getInitialState()).toMatchObject({
      activeProject: { id: "proj-legacy", name: "", role: "admin" },
    });
  });

  it("[tag:project-context] drops an unknown legacy role during migration", async () => {
    localStorage.setItem("agent-studio.active-project-id", "proj-legacy");
    localStorage.setItem("agent-studio.active-project-role", "not-a-role");
    vi.resetModules();

    const { projectContextSlice: reloadedSlice } = await import("./project-context.slice");

    expect(reloadedSlice.getInitialState()).toMatchObject({
      activeProject: { id: "proj-legacy", name: "", role: null },
    });
  });
});
