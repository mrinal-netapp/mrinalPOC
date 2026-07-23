import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { explorerList, startExplorerSession } from "./explorer-api";
import { buildNemoContextHeaders } from "./api.slice";

vi.mock("./api.slice", () => ({
  buildNemoContextHeaders: vi.fn(),
}));

describe("explorer-api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("[tag:explorer-api] startExplorerSession posts project and connector ids", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sessionId: "sess-1" }),
    } as unknown as Response);

    const resp = await startExplorerSession("proj-1", "conn-1");
    expect(resp).toEqual({ sessionId: "sess-1" });

    expect(buildNemoContextHeaders).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/workflow/api/v1/explore/session");
    expect(JSON.parse(String(init?.body))).toEqual({
      projectId: "proj-1",
      connectorId: "conn-1",
    });
  });

  it("[tag:explorer-api] explorerList sends minimal body when options omitted", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ nodes: [] }),
    } as unknown as Response);

    await explorerList("s/1", "listBuckets", { path: "/" });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/workflow/api/v1/explore/session/s%2F1/list");
    expect(JSON.parse(String(init?.body))).toEqual({
      action: "listBuckets",
      payload: { path: "/" },
    });
  });

  it("[tag:explorer-api] explorerList includes direct mode and refresh options", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ nodes: [{ id: "n1", label: "Node 1", type: "bucket" }] }),
    } as unknown as Response);

    const resp = await explorerList(
      "sess-2",
      "listPath",
      { prefix: "a/" },
      { projectId: "proj-2", connectorId: "conn-2", refresh: true },
    );

    expect(resp.nodes).toHaveLength(1);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      action: "listPath",
      payload: { prefix: "a/" },
      projectId: "proj-2",
      connectorId: "conn-2",
      refresh: true,
    });
  });

  it("[tag:explorer-api] explorerList omits direct mode when only one id is set", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ nodes: [] }),
    } as unknown as Response);

    await explorerList("sess-3", "listSchemas", {}, { projectId: "proj-only" });

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      action: "listSchemas",
      payload: {},
    });
  });

  it("[tag:explorer-api] throws with backend response text on non-OK", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => "invalid action",
    } as unknown as Response);

    await expect(explorerList("sess-4", "badAction")).rejects.toThrow(
      "Explorer API error 400: invalid action",
    );
  });
});
