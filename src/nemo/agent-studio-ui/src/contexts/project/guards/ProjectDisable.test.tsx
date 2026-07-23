import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@test/render";
import { Button } from "@/ui-lib/base-components/button/button";
import { ProjectDisable } from "./ProjectDisable";

describe("ProjectDisable", () => {
  it("[tag:project-disable] keeps design-system button enabled for allowed admin users", () => {
    renderWithProviders(
      <ProjectDisable requiredRoles={["admin"]}>
        <Button label="Save" onClick={() => {}} />
      </ProjectDisable>,
      {
        preloadedState: {
          projectContext: {
            activeProject: { id: "proj-alpha", name: "Alpha", role: "admin" },
          },
        },
      },
    );

    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
  });

  it("[tag:project-disable] disables design-system button when role is not allowed", () => {
    renderWithProviders(
      <ProjectDisable requiredRoles={["admin"]}>
        <Button label="Save" onClick={() => {}} />
      </ProjectDisable>,
      {
        preloadedState: {
          projectContext: {
            activeProject: { id: "proj-alpha", name: "Alpha", role: "viewer" },
          },
        },
      },
    );

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("[tag:project-disable] disables native button hosts when project is required but missing", () => {
    renderWithProviders(
      <ProjectDisable requireProject>
        <button type="button">Native action</button>
      </ProjectDisable>,
      {
        projectContext: { activeProject: null },
      },
    );

    const button = screen.getByRole("button", { name: "Native action" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
  });

  it("[tag:project-disable] throws when child is not a valid element", () => {
    expect(() =>
      renderWithProviders(
        // @ts-expect-error intentionally invalid child to exercise runtime guard
        <ProjectDisable>{"invalid"}</ProjectDisable>,
      ),
    ).toThrow(/expects a single ReactElement child/i);
  });
});
