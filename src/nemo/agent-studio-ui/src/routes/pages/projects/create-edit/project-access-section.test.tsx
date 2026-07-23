import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { renderWithProviders, userEvent } from "@test/render";
import { mockFetchByUrl, mockFetchSuccess, restoreAllMocks } from "@test/api-mock";
import { PROJECT_FORM_STRINGS } from "./project-form.consts";
import {
  PROJECT_ACCESS_STRINGS,
  computeAccessMemberChanges,
  createAccessUserRow,
} from "./project-access.consts";
import { ProjectAccessSection } from "./project-access-section";

const MEMBERS_RESPONSE = {
  projectId: "proj-alpha",
  members: [
    {
      userId: "user-123",
      email: "user-123@example.com",
      role: "admin",
    },
  ],
};

describe("computeAccessMemberChanges", () => {
  it("[tag:project-access] computes add, remove, and role updates", () => {
    const initialEmails = ["alice@example.com", "bob@example.com"];
    const initialRoles = {
      "alice@example.com": "admin" as const,
      "bob@example.com": "member" as const,
    };

    const changes = computeAccessMemberChanges(
      initialEmails,
      initialRoles,
      [
        { localId: "user-123", userId: "user-123", email: "alice@example.com", role: "member" },
        createAccessUserRow({ email: "carol@example.com", role: "admin" }),
      ],
    );

    expect(changes.removedEmails).toEqual(["bob@example.com"]);
    expect(changes.roleUpdates).toEqual([{ email: "alice@example.com", role: "member" }]);
    expect(changes.invites).toEqual([{ email: "carol@example.com", role: "admin" }]);
  });

  it("[tag:project-access] ignores duplicate emails when computing member changes", () => {
    const changes = computeAccessMemberChanges([], {}, [
      createAccessUserRow({ email: "user@example.com", role: "viewer" }),
      createAccessUserRow({ email: "user@example.com", role: "admin" }),
    ]);

    expect(changes.invites).toEqual([{ email: "user@example.com", role: "viewer" }]);
  });
});

describe("ProjectAccessSection", () => {
  beforeEach(() => {
    mockFetchSuccess(MEMBERS_RESPONSE);
  });

  afterEach(() => {
    restoreAllMocks();
  });

  async function expandAccessSection(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByRole("button", { name: new RegExp(PROJECT_FORM_STRINGS.ACCESS_SECTION_TITLE) }));
  }

  it("[tag:project-access] keeps access collapsed by default on create", () => {
    renderWithProviders(
      <ProjectAccessSection onPendingInvitesChange={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: new RegExp(PROJECT_FORM_STRINGS.ACCESS_SECTION_TITLE) })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(PROJECT_ACCESS_STRINGS.INTRO)).not.toBeInTheDocument();
  });

  it("[tag:project-access] shows action needed on create when invite later is selected", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <ProjectAccessSection onPendingInvitesChange={vi.fn()} />,
    );

    await expandAccessSection(user);
    await user.click(screen.getByRole("radio", { name: PROJECT_ACCESS_STRINGS.INVITE_LATER_LABEL }));

    expect(screen.getByText(PROJECT_ACCESS_STRINGS.ACTION_NEEDED)).toBeInTheDocument();
    expect(screen.getByText(PROJECT_ACCESS_STRINGS.INVITE_LATER_INFO)).toBeInTheDocument();
  });

  it("[tag:project-access] adds pending invite on create via user rows", async () => {
    const user = userEvent.setup();
    const onPendingInvitesChange = vi.fn();

    renderWithProviders(
      <ProjectAccessSection onPendingInvitesChange={onPendingInvitesChange} />,
    );

    await expandAccessSection(user);
    await user.type(
      screen.getByLabelText(`${PROJECT_ACCESS_STRINGS.EMAIL_ADDRESS_LABEL} 1`),
      "user-456@example.com",
    );

    await waitFor(() => {
      expect(onPendingInvitesChange).toHaveBeenCalledWith([
        { email: "user-456@example.com", role: "viewer" },
      ]);
    });
  });

  it("[tag:project-access] shows member count on edit", async () => {
    renderWithProviders(<ProjectAccessSection projectId="proj-alpha" />);

    await waitFor(() => {
      expect(screen.getByText("1 user")).toBeInTheDocument();
    });
  });

  it("[tag:project-access] renders user rows and add user on edit", async () => {
    renderWithProviders(<ProjectAccessSection projectId="proj-alpha" />);

    await waitFor(() => {
      expect(screen.getByText(PROJECT_ACCESS_STRINGS.USERS_HEADING(1))).toBeInTheDocument();
    });

    expect(screen.getByLabelText(`${PROJECT_ACCESS_STRINGS.EMAIL_ADDRESS_LABEL} 1`)).toHaveValue("user-123@example.com");
    expect(screen.getByRole("button", { name: PROJECT_ACCESS_STRINGS.ADD_USER_LABEL })).toBeInTheDocument();
  });

  it("[tag:project-access] shows loading state while members load on edit", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));

    renderWithProviders(<ProjectAccessSection projectId="proj-alpha" />);

    expect(document.querySelector(".project-access-section__loading")).toBeInTheDocument();
    expect(screen.getByText(PROJECT_ACCESS_STRINGS.LOADING_MEMBERS)).toBeInTheDocument();
  });

  it("[tag:project-access] shows inline error when members query fails on edit", async () => {
    mockFetchByUrl([
      {
        match: "/projects/proj-alpha/members",
        data: { error: "Server error" },
        status: 500,
      },
    ]);

    renderWithProviders(<ProjectAccessSection projectId="proj-alpha" />);

    await waitFor(() => {
      expect(screen.getByText(PROJECT_ACCESS_STRINGS.LOAD_MEMBERS_ERROR)).toBeInTheDocument();
    });
  });

  it("[tag:project-access] adds and removes user rows on edit", async () => {
    const user = userEvent.setup();
    const onMemberChangesChange = vi.fn();

    renderWithProviders(
      <ProjectAccessSection projectId="proj-alpha" onMemberChangesChange={onMemberChangesChange} />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText(`${PROJECT_ACCESS_STRINGS.EMAIL_ADDRESS_LABEL} 1`)).toHaveValue("user-123@example.com");
    });

    await user.click(screen.getByRole("button", { name: PROJECT_ACCESS_STRINGS.ADD_USER_LABEL }));
    expect(screen.getByLabelText(`${PROJECT_ACCESS_STRINGS.EMAIL_ADDRESS_LABEL} 2`)).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: PROJECT_ACCESS_STRINGS.REMOVE_USER_ARIA_LABEL })[0]!);
    await waitFor(() => {
      expect(onMemberChangesChange).toHaveBeenCalled();
    });
  });

  it("[tag:project-access] handles edit members without email addresses", async () => {
    mockFetchByUrl([
      {
        match: "/projects/proj-alpha/members",
        data: {
          projectId: "proj-alpha",
          members: [{ userId: "legacy-user", role: "admin" }],
        },
      },
    ]);

    renderWithProviders(<ProjectAccessSection projectId="proj-alpha" />);

    await waitFor(() => {
      expect(screen.getByLabelText(`${PROJECT_ACCESS_STRINGS.EMAIL_ADDRESS_LABEL} 1`)).toHaveValue("");
    });
    expect(screen.getByText(PROJECT_ACCESS_STRINGS.USERS_HEADING(1))).toBeInTheDocument();
  });

  it("[tag:project-access] removes the last create-mode row by resetting it", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <ProjectAccessSection onPendingInvitesChange={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: new RegExp(PROJECT_FORM_STRINGS.ACCESS_SECTION_TITLE) }));
    await user.click(screen.getByRole("button", { name: PROJECT_ACCESS_STRINGS.ADD_USER_LABEL }));
    expect(screen.getByLabelText(`${PROJECT_ACCESS_STRINGS.EMAIL_ADDRESS_LABEL} 2`)).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: PROJECT_ACCESS_STRINGS.REMOVE_USER_ARIA_LABEL })[0]!);
    expect(screen.queryByLabelText(`${PROJECT_ACCESS_STRINGS.EMAIL_ADDRESS_LABEL} 2`)).not.toBeInTheDocument();
    expect(screen.getByLabelText(`${PROJECT_ACCESS_STRINGS.EMAIL_ADDRESS_LABEL} 1`)).toHaveValue("");
  });

  it("[tag:project-access] renders mockup invite controls on create", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <ProjectAccessSection onPendingInvitesChange={vi.fn()} />,
    );

    expect(screen.getByText(PROJECT_FORM_STRINGS.ACCESS_SECTION_TITLE)).toBeInTheDocument();
    await expandAccessSection(user);

    expect(screen.getByText(PROJECT_ACCESS_STRINGS.INTRO)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: PROJECT_ACCESS_STRINGS.INVITE_NOW_LABEL })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: PROJECT_ACCESS_STRINGS.INVITE_LATER_LABEL })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: PROJECT_ACCESS_STRINGS.ADD_USER_LABEL })).toBeInTheDocument();
    expect(screen.getByText(PROJECT_ACCESS_STRINGS.USERS_HEADING(1))).toBeInTheDocument();
  });
});
