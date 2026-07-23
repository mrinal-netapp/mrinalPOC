import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders, userEvent } from "@test/render";
import { ProjectsManagementSidebar } from "./projects-management-sidebar";

const mockNavigate = vi.fn();

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe("ProjectsManagementSidebar", () => {
  it("[tag:projects-management-sidebar] renders service context tabs and projects nav item", () => {
    renderWithProviders(<ProjectsManagementSidebar open />, {
      initialEntries: ["/projects"],
    });

    expect(screen.getByTestId("projects-management-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("service-context-tabs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Projects" })).toBeInTheDocument();
  });

  it("[tag:projects-management-sidebar] navigates when projects nav item is clicked", async () => {
    const user = userEvent.setup();
    mockNavigate.mockClear();

    renderWithProviders(<ProjectsManagementSidebar open />, {
      initialEntries: ["/projects/create"],
    });

    await user.click(screen.getByRole("button", { name: "Projects" }));
    expect(mockNavigate).toHaveBeenCalledWith("/projects");
  });
});
