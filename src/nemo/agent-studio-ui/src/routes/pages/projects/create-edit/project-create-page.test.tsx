import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Route, Routes } from "react-router";

import { renderWithProviders } from "@test/render";
import { PROJECT_FORM_STRINGS } from "./project-form.consts";
import { ProjectCreatePage } from "./project-create-page";

describe("ProjectCreatePage", () => {
  it("[tag:project-create-page] renders create form at /projects/create", () => {
    renderWithProviders(
      <Routes>
        <Route path="/projects/create" element={<ProjectCreatePage />} />
      </Routes>,
      { initialEntries: ["/projects/create"] },
    );

    expect(screen.getByRole("heading", { name: PROJECT_FORM_STRINGS.CREATE_TITLE })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: PROJECT_FORM_STRINGS.ADD_LABEL })).toBeInTheDocument();
  });
});
