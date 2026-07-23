import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders, userEvent } from "@test/render";
import { ADMINISTRATION_MEMBERS_STRINGS } from "./administration-members.consts";
import { MemberForm } from "./member-form";

describe("MemberForm", () => {
  it("[tag:member-form] renders add user mockup layout", () => {
    renderWithProviders(
      <MemberForm open mode="add" onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(screen.getByRole("heading", { name: ADMINISTRATION_MEMBERS_STRINGS.ADD_FORM_TITLE })).toBeInTheDocument();
    expect(screen.getByText(ADMINISTRATION_MEMBERS_STRINGS.ADD_FORM_SUBTITLE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.ADD_LABEL })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.CANCEL_LABEL })).toBeInTheDocument();
    expect(screen.getByText(ADMINISTRATION_MEMBERS_STRINGS.ROLE_SECTION_TITLE)).toBeInTheDocument();
  });

  it("[tag:member-form] uses Save label in edit mode", () => {
    renderWithProviders(
      <MemberForm
        open
        mode="edit"
        initialValues={{ name: "Al Smith", email: "al@example.com", role: "admin" }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.SAVE_LABEL })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.ADD_LABEL })).not.toBeInTheDocument();
  });

  it("[tag:member-form] validates required fields on submit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    renderWithProviders(
      <MemberForm open mode="add" onSubmit={onSubmit} onCancel={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.ADD_LABEL }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(ADMINISTRATION_MEMBERS_STRINGS.NAME_REQUIRED)).toBeInTheDocument();
    expect(screen.getByText(ADMINISTRATION_MEMBERS_STRINGS.EMAIL_REQUIRED)).toBeInTheDocument();
  });

  it("[tag:member-form] submits values and calls cancel handler", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();

    renderWithProviders(
      <MemberForm open mode="add" onSubmit={onSubmit} onCancel={onCancel} />,
    );

    await user.type(screen.getByLabelText(ADMINISTRATION_MEMBERS_STRINGS.NAME_LABEL), "Carol Jones");
    await user.type(screen.getByLabelText(ADMINISTRATION_MEMBERS_STRINGS.EMAIL_LABEL), "carol@example.com");
    await user.click(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.ADD_LABEL }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "Carol Jones",
      email: "carol@example.com",
      role: "viewer",
    });

    await user.click(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.CANCEL_LABEL }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("[tag:member-form] renders edit form title and keeps email disabled", () => {
    renderWithProviders(
      <MemberForm
        open
        mode="edit"
        initialValues={{ name: "Al Smith", email: "al@example.com", role: "admin" }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText(ADMINISTRATION_MEMBERS_STRINGS.EDIT_FORM_SUBTITLE)).toBeInTheDocument();
    expect(screen.getByLabelText(ADMINISTRATION_MEMBERS_STRINGS.EMAIL_LABEL)).toBeDisabled();
    expect(screen.getByLabelText(ADMINISTRATION_MEMBERS_STRINGS.NAME_LABEL)).toBeDisabled();
  });
});
