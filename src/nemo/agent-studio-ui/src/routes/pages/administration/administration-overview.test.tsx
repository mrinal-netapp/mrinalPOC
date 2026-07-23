import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";

import { renderWithProviders } from "@test/render";
import { mockFetchSuccess, restoreAllMocks } from "@test/api-mock";
import type { Project } from "@/api/project.types";
import { AdministrationOverview } from "./administration-overview";

const PROJECT: Project = {
  id: "proj-alpha",
  name: "Alpha Project",
  created_at: "2026-05-25T14:32:10.123Z",
  updated_at: "2026-05-25T14:32:10.123Z",
  metadata: { description: "Workspace description" },
  home_dir: "s3://default-nemo/projects/proj-alpha",
};

describe("AdministrationOverview", () => {
  afterEach(() => {
    restoreAllMocks();
  });

  it("[tag:administration-overview] renders fetched project name and description", async () => {
    mockFetchSuccess(PROJECT);

    renderWithProviders(<AdministrationOverview />, {
      preloadedState: {
        projectContext: {
          activeProject: { id: "proj-alpha", name: "Alpha Project", role: "admin" },
        },
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Alpha Project")).toBeInTheDocument();
      expect(screen.getByText("Workspace description")).toBeInTheDocument();
    });
  });

  it("[tag:administration-overview] falls back to active project name and em dash description", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));

    renderWithProviders(<AdministrationOverview />, {
      preloadedState: {
        projectContext: {
          activeProject: { id: "proj-alpha", name: "Stored Project Name", role: "admin" },
        },
      },
    });

    expect(screen.getByText("Stored Project Name")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
