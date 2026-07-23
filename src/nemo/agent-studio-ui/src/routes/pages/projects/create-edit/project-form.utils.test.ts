import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { createMockStore } from "@test/mocks";
import { mockFetchByUrl, restoreAllMocks } from "@test/api-mock";
import { apiSlice } from "@/api/api.slice";
import { PROJECT_METADATA_DESCRIPTION_KEY } from "@/api/project.types";
import type { Project } from "@/api/project.types";
import { PROJECT_ACCESS_STRINGS } from "./project-access.consts";
import { PROJECT_FORM_STRINGS } from "./project-form.consts";
import {
  buildProjectCreatePayload,
  buildProjectFormValuesFromProject,
  buildProjectUpdatePayload,
  normalizeMemberInvites,
  validateProjectFormOnSubmit,
  waitForProjectMembershipReady,
} from "./project-form.utils";

const PROJECT: Project = {
  id: "projabc123",
  name: "Team A",
  created_at: "2026-05-25T14:32:10.123Z",
  updated_at: "2026-05-25T14:32:10.123Z",
  metadata: { description: "Workspace" },
  home_dir: "s3://default-nemo/projects/projabc123",
};

describe("buildProjectCreatePayload", () => {
  it("[tag:project-form] maps name and description to create request", () => {
    expect(
      buildProjectCreatePayload({ name: "  Team A  ", description: "  Workspace  " }),
    ).toEqual({
      name: "Team A",
      metadata: { [PROJECT_METADATA_DESCRIPTION_KEY]: "Workspace" },
    });
  });

  it("[tag:project-form] omits metadata when description is empty", () => {
    expect(buildProjectCreatePayload({ name: "Team A", description: "   " })).toEqual({
      name: "Team A",
    });
  });
});

describe("buildProjectUpdatePayload", () => {
  it("[tag:project-form] maps name and description to update request", () => {
    expect(
      buildProjectUpdatePayload({ name: "Team B", description: "Updated" }),
    ).toEqual({
      name: "Team B",
      metadata: { [PROJECT_METADATA_DESCRIPTION_KEY]: "Updated" },
    });
  });

  it("[tag:project-form] sends empty metadata object when description is cleared", () => {
    expect(buildProjectUpdatePayload({ name: "Team B", description: "   " })).toEqual({
      name: "Team B",
      metadata: {},
    });
  });
});

describe("buildProjectFormValuesFromProject", () => {
  it("[tag:project-form] maps project API model to form values", () => {
    expect(buildProjectFormValuesFromProject(PROJECT)).toEqual({
      name: "Team A",
      description: "Workspace",
    });
  });
});

describe("validateProjectFormOnSubmit", () => {
  it("[tag:project-form] requires a project name", () => {
    expect(validateProjectFormOnSubmit({ value: { name: "   ", description: "" } })).toEqual({
      fields: { name: PROJECT_FORM_STRINGS.NAME_REQUIRED },
    });
    expect(validateProjectFormOnSubmit({ value: { name: "Team A", description: "" } })).toBeUndefined();
  });
});

describe("normalizeMemberInvites", () => {
  it("[tag:project-form] trims and lowercases invite emails", () => {
    expect(normalizeMemberInvites([{ email: "  User@Example.com ", role: "viewer" }])).toEqual([
      { email: "user@example.com", role: "viewer" },
    ]);
  });

  it("[tag:project-form] rejects empty and invalid invite emails", () => {
    expect(() => normalizeMemberInvites([{ email: "   ", role: "viewer" }])).toThrow(
      PROJECT_ACCESS_STRINGS.EMAIL_REQUIRED,
    );
    expect(() => normalizeMemberInvites([{ email: "not-an-email", role: "viewer" }])).toThrow(
      "Enter a valid email address",
    );
  });
});

describe("waitForProjectMembershipReady", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreAllMocks();
  });

  it("[tag:project-form] returns true once listProjectMembers succeeds", async () => {
    mockFetchByUrl([
      {
        match: "/projects/projabc123/members",
        data: { projectId: "projabc123", members: [] },
      },
    ]);

    const store = createMockStore();
    const promise = waitForProjectMembershipReady(store.dispatch, "projabc123", 3, 100);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe(true);
    store.dispatch(apiSlice.util.resetApiState());
  });

  it("[tag:project-form] returns false after max attempts", async () => {
    mockFetchByUrl([
      {
        match: "/projects/projabc123/members",
        data: { error: "not ready" },
        status: 500,
      },
    ]);

    const store = createMockStore();
    const promise = waitForProjectMembershipReady(store.dispatch, "projabc123", 2, 100);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe(false);
    store.dispatch(apiSlice.util.resetApiState());
  });
});
