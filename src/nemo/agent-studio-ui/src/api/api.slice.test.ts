import { describe, expect, it } from "vitest";

import { buildNemoContextHeaders, encodeNemoContext, resolveNemoContext } from "./api.slice";
import { setRuntimeAccessToken } from "./auth-access-token";
import { DEFAULT_NEMO_CONTEXT, NEMO_CONTEXT_HEADER } from "@/consts/api.consts";

function createProjectContextGetState(activeProjectId: string) {
  return () => ({
    projectContext: {
      activeProject: {
        id: activeProjectId,
        name: "Test Project",
        role: null,
      },
    },
  });
}

describe("resolveNemoContext", () => {
  it("[tag:api-slice] prefers active project from Redux store over env default", () => {
    const context = resolveNemoContext(createProjectContextGetState("store-project-id"));
    expect(context.project_id).toBe("store-project-id");
    expect(context.user_id).toBe(DEFAULT_NEMO_CONTEXT.user_id);
    expect(context.org_id).toBe(DEFAULT_NEMO_CONTEXT.org_id);
  });

  it("[tag:api-slice] buildNemoContextHeaders encodes store project id", () => {
    const headers = new Headers();
    buildNemoContextHeaders(headers, createProjectContextGetState("header-project-id"));

    const encoded = headers.get(NEMO_CONTEXT_HEADER);
    expect(encoded).toBeTruthy();

    const decoded = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(encoded!), (char) => char.codePointAt(0)!),
      ),
    );
    expect(decoded.project_id).toBe("header-project-id");
  });

  it("[tag:api-slice] buildNemoContextHeaders sets Authorization when access token is available", () => {
    setRuntimeAccessToken("test-access-token");

    const headers = new Headers();
    buildNemoContextHeaders(headers);

    expect(headers.get("Authorization")).toBe("Bearer test-access-token");

    setRuntimeAccessToken(null);
  });
});

describe("encodeNemoContext", () => {
  it("[tag:api-slice] round-trips context payload", () => {
    const encoded = encodeNemoContext({
      project_id: "proj-1",
      user_id: "user-1",
      org_id: "org-1",
    });

    const decoded = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(encoded), (char) => char.codePointAt(0)!),
      ),
    );

    expect(decoded).toEqual({
      project_id: "proj-1",
      user_id: "user-1",
      org_id: "org-1",
    });
  });
});
