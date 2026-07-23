import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@test/render";
import { ProjectGuard } from "./ProjectGuard";

describe("ProjectGuard", () => {
  it("[tag:project-guard] renders children when access is allowed", () => {
    renderWithProviders(
      <ProjectGuard requiredRoles={["admin"]}>
        <div>Protected content</div>
      </ProjectGuard>,
      {
        preloadedState: {
          projectContext: {
            activeProject: { id: "proj-alpha", name: "Alpha", role: "admin" },
          },
        },
      },
    );

    expect(screen.getByText("Protected content")).toBeInTheDocument();
  });

  it("[tag:project-guard] renders fallback when role does not match", () => {
    renderWithProviders(
      <ProjectGuard requiredRoles={["admin"]} fallback={<div>Access denied</div>}>
        <div>Protected content</div>
      </ProjectGuard>,
      {
        preloadedState: {
          projectContext: {
            activeProject: { id: "proj-alpha", name: "Alpha", role: "member" },
          },
        },
      },
    );

    expect(screen.getByText("Access denied")).toBeInTheDocument();
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
  });

  it("[tag:project-guard] renders loading fallback while projects are loading", () => {
    renderWithProviders(
      <ProjectGuard loadingFallback={<div>Loading projects</div>}>
        <div>Protected content</div>
      </ProjectGuard>,
      {
        projectContext: { loading: true, activeProject: null },
      },
    );

    expect(screen.getByText("Loading projects")).toBeInTheDocument();
  });

  it("[tag:project-guard] allows content without an active project when project is not required", () => {
    renderWithProviders(
      <ProjectGuard requireProject={false}>
        <div>Global content</div>
      </ProjectGuard>,
      {
        projectContext: { activeProject: null },
      },
    );

    expect(screen.getByText("Global content")).toBeInTheDocument();
  });
});
