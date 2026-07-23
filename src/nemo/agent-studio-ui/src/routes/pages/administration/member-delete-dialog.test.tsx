import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders, userEvent } from "@test/render";
import { ADMINISTRATION_MEMBERS_STRINGS } from "./administration-members.consts";
import { MemberDeleteDialog } from "./member-delete-dialog";

describe("MemberDeleteDialog", () => {
  it("[tag:member-delete-dialog] renders confirmation copy and standardized button order", () => {
    renderWithProviders(
      <MemberDeleteDialog
        open
        memberName="Al Smith"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(document.querySelector(".card-header__title")).toHaveTextContent(
      ADMINISTRATION_MEMBERS_STRINGS.DELETE_DIALOG_TITLE,
    );
    expect(screen.getByText(/Are you sure that you want to delete the user/i)).toBeInTheDocument();
    expect(screen.getByText("Al Smith")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveTextContent(
      ADMINISTRATION_MEMBERS_STRINGS.DELETE_UNDO_WARNING,
    );

    const buttons = screen.getAllByRole("button", {
      name: new RegExp(
        `${ADMINISTRATION_MEMBERS_STRINGS.DELETE_CONFIRM_LABEL}|${ADMINISTRATION_MEMBERS_STRINGS.DELETE_CANCEL_LABEL}`,
      ),
    });
    expect(buttons[0]).toHaveAccessibleName(ADMINISTRATION_MEMBERS_STRINGS.DELETE_CANCEL_LABEL);
    expect(buttons[1]).toHaveAccessibleName(ADMINISTRATION_MEMBERS_STRINGS.DELETE_CONFIRM_LABEL);
  });

  it("[tag:member-delete-dialog] calls confirm and cancel handlers", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    renderWithProviders(
      <MemberDeleteDialog
        open
        memberName="Al Smith"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.DELETE_CONFIRM_LABEL }));
    await user.click(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.DELETE_CANCEL_LABEL }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("[tag:member-delete-dialog] disables cancel while loading", () => {
    renderWithProviders(
      <MemberDeleteDialog
        open
        memberName="Al Smith"
        loading
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.DELETE_CANCEL_LABEL }),
    ).toBeDisabled();
  });

  it("[tag:member-delete-dialog] ignores dismiss while loading", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();

    renderWithProviders(
      <MemberDeleteDialog
        open
        memberName="Al Smith"
        loading
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    await user.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("[tag:member-delete-dialog] calls onCancel when dialog is dismissed", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();

    renderWithProviders(
      <MemberDeleteDialog
        open
        memberName="Al Smith"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
