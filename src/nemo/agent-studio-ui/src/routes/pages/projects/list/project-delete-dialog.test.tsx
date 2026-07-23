import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders, userEvent } from "@test/render";
import { PROJECT_DELETE_STRINGS } from "../create-edit/project-form.consts";
import { ProjectDeleteDialog } from "./project-delete-dialog";

describe("ProjectDeleteDialog", () => {
  it("[tag:project-delete-dialog] renders mockup copy, emphasis, and button order", () => {
    renderWithProviders(
      <ProjectDeleteDialog
        open
        projectName="Dev project"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(document.querySelector(".card-header__title")).toHaveTextContent(PROJECT_DELETE_STRINGS.DIALOG_TITLE);
    expect(screen.getByText(/Are you sure that you want to delete the project/i)).toBeInTheDocument();
    expect(screen.getByText("Dev project")).toHaveClass("typography--semibold");
    expect(screen.getByText(PROJECT_DELETE_STRINGS.UNDO_WARNING)).toBeInTheDocument();

    const buttons = screen.getAllByRole("button", {
      name: new RegExp(`${PROJECT_DELETE_STRINGS.CONFIRM_LABEL}|${PROJECT_DELETE_STRINGS.CANCEL_LABEL}`),
    });
    expect(buttons[0]).toHaveAccessibleName(PROJECT_DELETE_STRINGS.CONFIRM_LABEL);
    expect(buttons[1]).toHaveAccessibleName(PROJECT_DELETE_STRINGS.CANCEL_LABEL);
    expect(document.body.innerHTML).not.toMatch(/destructive/);
  });

  it("[tag:project-delete-dialog] calls handlers for confirm and cancel", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    renderWithProviders(
      <ProjectDeleteDialog
        open
        projectName="Dev project"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole("button", { name: PROJECT_DELETE_STRINGS.CONFIRM_LABEL }));
    await user.click(screen.getByRole("button", { name: PROJECT_DELETE_STRINGS.CANCEL_LABEL }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("[tag:project-delete-dialog] disables cancel while delete is in progress", () => {
    renderWithProviders(
      <ProjectDeleteDialog
        open
        projectName="Dev project"
        loading
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: PROJECT_DELETE_STRINGS.CANCEL_LABEL }),
    ).toBeDisabled();
  });

  it("[tag:project-delete-dialog] ignores dismiss while delete is in progress", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();

    renderWithProviders(
      <ProjectDeleteDialog
        open
        projectName="Dev project"
        loading
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    await user.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("[tag:project-delete-dialog] calls onCancel when dialog is dismissed", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();

    renderWithProviders(
      <ProjectDeleteDialog
        open
        projectName="Dev project"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
