import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { columnHistogram, previewDataset, queryDataset } from "./analytics-api";
import { buildNemoContextHeaders } from "./api.slice";

vi.mock("./api.slice", () => ({
  buildNemoContextHeaders: vi.fn(),
}));

describe("analytics-api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("[tag:analytics-api] previewDataset posts defaults without orderBy", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ columns: [], columnTypes: [], rows: [], rowCount: 0, totalCount: 0, offsetCapped: false }),
    } as unknown as Response);

    await previewDataset("ns1", "tbl1");

    expect(buildNemoContextHeaders).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/analytics/api/v1/datasets/preview");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      namespace: "ns1",
      table: "tbl1",
      limit: 50,
      offset: 0,
      filters: [],
    });
  });

  it("[tag:analytics-api] previewDataset includes orderBy when provided", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ columns: ["a"], columnTypes: ["VARCHAR"], rows: [["x"]], rowCount: 1, totalCount: 1, offsetCapped: false }),
    } as unknown as Response);

    await previewDataset("ns2", "tbl2", {
      limit: 10,
      offset: 20,
      filters: [{ column: "a", op: "=", value: "x" }],
      orderBy: { column: "a", direction: "asc" },
    });

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      namespace: "ns2",
      table: "tbl2",
      limit: 10,
      offset: 20,
      filters: [{ column: "a", op: "=", value: "x" }],
      orderBy: { column: "a", direction: "asc" },
    });
  });

  it("[tag:analytics-api] queryDataset posts query body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ columns: [], columnTypes: [], rows: null, rowCount: 0, totalCount: 0, offsetCapped: false }),
    } as unknown as Response);

    await queryDataset("SELECT 1");

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/analytics/api/flightsql/query");
    expect(JSON.parse(String(init?.body))).toEqual({ query: "SELECT 1" });
  });

  it("[tag:analytics-api] columnHistogram forwards filters and signal", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ buckets: [{ label: "0-10", count: 2 }] }),
    } as unknown as Response);

    const controller = new AbortController();
    await columnHistogram("ns3", "tbl3", "amount", [{ column: "region", op: "=", value: "us" }], controller.signal);

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/analytics/api/v1/datasets/histogram");
    expect(init?.signal).toBe(controller.signal);
    expect(JSON.parse(String(init?.body))).toEqual({
      namespace: "ns3",
      table: "tbl3",
      column: "amount",
      filters: [{ column: "region", op: "=", value: "us" }],
    });
  });

  it("[tag:analytics-api] throws error with response text when non-OK", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Server Error",
      text: async () => "boom",
    } as unknown as Response);

    await expect(previewDataset("ns", "tbl")).rejects.toThrow("Analytics API error 500: boom");
  });

  it("[tag:analytics-api] falls back to statusText when text() fails", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: async () => {
        throw new Error("read failed");
      },
    } as unknown as Response);

    await expect(queryDataset("SELECT 1")).rejects.toThrow("Analytics API error 503: Service Unavailable");
  });
});
