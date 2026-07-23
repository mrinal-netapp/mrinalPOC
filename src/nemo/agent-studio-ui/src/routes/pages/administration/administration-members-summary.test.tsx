import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ADMINISTRATION_MEMBERS_STRINGS } from "./administration-members.consts";
import { AdministrationMembersSummary } from "./administration-members-summary";

describe("AdministrationMembersSummary", () => {
  it("[tag:administration-members] renders all four role summary metrics", () => {
    render(
      <AdministrationMembersSummary
        summary={{ total: 12, admins: 4, members: 3, viewers: 5 }}
      />,
    );

    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText(ADMINISTRATION_MEMBERS_STRINGS.SUMMARY_TOTAL)).toBeInTheDocument();
    expect(screen.getByText(ADMINISTRATION_MEMBERS_STRINGS.SUMMARY_ADMINS)).toBeInTheDocument();
    expect(screen.getByText(ADMINISTRATION_MEMBERS_STRINGS.SUMMARY_MEMBERS)).toBeInTheDocument();
    expect(screen.getByText(ADMINISTRATION_MEMBERS_STRINGS.SUMMARY_VIEWERS)).toBeInTheDocument();
  });
});
