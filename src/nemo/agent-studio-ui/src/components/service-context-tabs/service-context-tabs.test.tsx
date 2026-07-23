import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Route, Routes } from "react-router";

import { renderWithProviders, userEvent } from "@test/render";
import { ROUTES } from "@/routes/routes.consts";
import { PROJECTS_LIST_STRINGS } from "@/routes/pages/projects/projects.consts";
import { ServiceContextTabs } from "./service-context-tabs";

describe("ServiceContextTabs", () => {
  it("[tag:service-context-tabs] marks Agent Studio active on overview route", () => {
    renderWithProviders(<ServiceContextTabs />, {
      initialEntries: [`/${ROUTES.OVERVIEW}`],
    });

    expect(screen.getByRole("tab", { name: "Agent Studio" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Management" })).toHaveAttribute("aria-selected", "false");
  });

  it("[tag:service-context-tabs] marks Management active on projects route", () => {
    renderWithProviders(<ServiceContextTabs />, {
      initialEntries: [`/${ROUTES.PROJECTS}`],
    });

    expect(screen.getByRole("tab", { name: "Management" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Agent Studio" })).toHaveAttribute("aria-selected", "false");
  });

  it("[tag:service-context-tabs] navigates between Agent Studio and Management", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <>
        <ServiceContextTabs />
        <Routes>
          <Route path={`/${ROUTES.OVERVIEW}`} element={<div>Overview page</div>} />
          <Route path={`/${ROUTES.PROJECTS}`} element={<div>{PROJECTS_LIST_STRINGS.PAGE_TITLE}</div>} />
        </Routes>
      </>,
      { initialEntries: [`/${ROUTES.PROJECTS}`] },
    );

    await user.click(screen.getByRole("tab", { name: "Agent Studio" }));
    expect(screen.getByText("Overview page")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Management" }));
    expect(screen.getByText(PROJECTS_LIST_STRINGS.PAGE_TITLE)).toBeInTheDocument();
  });
});
