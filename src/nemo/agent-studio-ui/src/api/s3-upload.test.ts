import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth-access-token", () => ({
  resolveAccessToken: vi.fn(),
}));

import { resolveAccessToken } from "./auth-access-token";
import {
  getDefaultS3Endpoint,
  getFileRelativePath,
  getObjectText,
  MANUAL_UPLOAD_CONCURRENCY,
  putObject,
  runWithConcurrency,
  sanitizeUploadRelativePath,
} from "./s3-upload";

class FakeXMLHttpRequest {
  static instances: FakeXMLHttpRequest[] = [];

  static reset(): void {
    FakeXMLHttpRequest.instances = [];
  }

  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn((body: Blob | File) => {
    this.sentBody = body;
  });
  abort = vi.fn();
  upload: { onprogress?: (event: ProgressEvent) => void } = {};
  status = 200;
  responseText = "";
  statusText = "OK";
  sentBody: Blob | File | undefined;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeXMLHttpRequest.instances.push(this);
  }
}

describe("s3-upload", () => {
  beforeEach(() => {
    FakeXMLHttpRequest.reset();
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest as unknown as typeof XMLHttpRequest);
    vi.mocked(resolveAccessToken).mockReturnValue("token-123");
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        protocol: "https:",
        host: "agentstudio.example.com",
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("[tag:s3-upload] builds the default endpoint from the browser location", () => {
    expect(getDefaultS3Endpoint()).toBe("https://agentstudio.example.com/s3");
  });

  it("[tag:s3-upload] resolves file relative paths", () => {
    const nestedFile = {
      name: "report.csv",
      webkitRelativePath: "folder/report.csv",
    } as File & { webkitRelativePath: string };
    const plainFile = { name: "single.txt" } as File;

    expect(getFileRelativePath(nestedFile)).toBe("folder/report.csv");
    expect(getFileRelativePath(plainFile)).toBe("single.txt");
  });

  it("[tag:s3-upload] sanitizes upload paths segment-by-segment", () => {
    expect(sanitizeUploadRelativePath("folder/my file?.txt")).toBe("folder/my_file_.txt");
    expect(sanitizeUploadRelativePath("/ /漢字//")).toBe("_/__");
  });

  it("[tag:s3-upload] uploads a file, reports progress, and sends auth + content-type headers", async () => {
    const onProgress = vi.fn();
    const uploadPromise = putObject(
      "bucket name",
      "folder/my file.txt",
      new File(["body"], "my file.txt", { type: "text/plain" }),
      onProgress,
    );

    const xhr = FakeXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("Expected an XMLHttpRequest instance.");

    expect(xhr.open).toHaveBeenCalledWith(
      "PUT",
      "https://agentstudio.example.com/s3/bucket%20name/folder/my%20file.txt",
      true,
    );
    expect(
      xhr.setRequestHeader.mock.calls.some(([name]) => name === "Authorization"),
    ).toBe(true);
    expect(xhr.setRequestHeader).toHaveBeenCalledWith("Content-Type", "text/plain");

    xhr.upload.onprogress?.({
      lengthComputable: true,
      loaded: 3,
      total: 7,
    } as ProgressEvent);
    expect(onProgress).toHaveBeenCalledWith(3, 7);

    xhr.status = 204;
    xhr.onload?.();
    await expect(uploadPromise).resolves.toBeUndefined();
  });

  it("[tag:s3-upload] falls back to application/octet-stream when the file has no content type", async () => {
    const uploadPromise = putObject(
      "bucket",
      "plain.bin",
      new File(["body"], "plain.bin"),
    );

    const xhr = FakeXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("Expected an XMLHttpRequest instance.");
    expect(xhr.setRequestHeader).toHaveBeenCalledWith("Content-Type", "application/octet-stream");

    xhr.status = 200;
    xhr.onload?.();
    await expect(uploadPromise).resolves.toBeUndefined();
  });

  it("[tag:s3-upload] rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      putObject("bucket", "file.txt", new File(["body"], "file.txt"), undefined, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeXMLHttpRequest.instances).toHaveLength(0);
  });

  it("[tag:s3-upload] rejects when the signal aborts during upload", async () => {
    const controller = new AbortController();
    const uploadPromise = putObject(
      "bucket",
      "file.txt",
      new File(["body"], "file.txt"),
      undefined,
      controller.signal,
    );

    const xhr = FakeXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("Expected an XMLHttpRequest instance.");

    controller.abort();

    expect(xhr.abort).toHaveBeenCalled();
    await expect(uploadPromise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("[tag:s3-upload] rejects with a response error for non-2xx uploads", async () => {
    const uploadPromise = putObject("bucket", "file.txt", new File(["body"], "file.txt"));

    const xhr = FakeXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("Expected an XMLHttpRequest instance.");
    xhr.status = 403;
    xhr.responseText = "forbidden";
    xhr.statusText = "Forbidden";
    xhr.onload?.();

    await expect(uploadPromise).rejects.toThrow("Upload failed (403): forbidden");
  });

  it("[tag:s3-upload] rejects on network errors", async () => {
    const uploadPromise = putObject("bucket", "file.txt", new File(["body"], "file.txt"));

    const xhr = FakeXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("Expected an XMLHttpRequest instance.");
    xhr.onerror?.();

    await expect(uploadPromise).rejects.toThrow("Network error during upload");
  });

  it("[tag:s3-upload] skips the auth header when no token is available and ignores non-computable progress events", async () => {
    vi.mocked(resolveAccessToken).mockReturnValue(null);
    const onProgress = vi.fn();
    const uploadPromise = putObject(
      "bucket",
      "file.txt",
      new File(["body"], "file.txt", { type: "text/plain" }),
      onProgress,
    );

    const xhr = FakeXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("Expected an XMLHttpRequest instance.");

    xhr.upload.onprogress?.({
      lengthComputable: false,
      loaded: 1,
      total: 2,
    } as ProgressEvent);
    expect(onProgress).not.toHaveBeenCalled();
    expect(
      xhr.setRequestHeader.mock.calls.some(([name]) => name === "Authorization"),
    ).toBe(false);

    xhr.status = 200;
    xhr.onload?.();
    await expect(uploadPromise).resolves.toBeUndefined();
  });

  it("[tag:s3-upload] falls back to statusText when the response body is empty", async () => {
    const uploadPromise = putObject("bucket", "file.txt", new File(["body"], "file.txt"));

    const xhr = FakeXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("Expected an XMLHttpRequest instance.");
    xhr.status = 500;
    xhr.responseText = "";
    xhr.statusText = "Internal Server Error";
    xhr.onload?.();

    await expect(uploadPromise).rejects.toThrow("Upload failed (500): Internal Server Error");
  });

  it("[tag:s3-upload] runs work with bounded concurrency", async () => {
    const started: number[] = [];
    const completed: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const resolvers: Array<() => void> = [];

    const runPromise = runWithConcurrency(
      6,
      MANUAL_UPLOAD_CONCURRENCY,
      async (index) => {
        started.push(index);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => {
          resolvers.push(() => {
            completed.push(index);
            inFlight -= 1;
            resolve();
          });
        });
      },
    );

    expect(started).toHaveLength(MANUAL_UPLOAD_CONCURRENCY);
    while (resolvers.length > 0) {
      resolvers.shift()?.();
      await Promise.resolve();
    }
    await runPromise;

    expect(started).toHaveLength(6);
    expect(completed).toHaveLength(6);
    expect(maxInFlight).toBeLessThanOrEqual(MANUAL_UPLOAD_CONCURRENCY);
  });

  it("[tag:s3-upload] clamps concurrency to at least one worker and exits early for empty task sets", async () => {
    const calls: number[] = [];

    await runWithConcurrency(0, 4, async (index) => {
      calls.push(index);
    });
    await runWithConcurrency(3, 0, async (index) => {
      calls.push(index);
    });

    expect(calls).toEqual([0, 1, 2]);
  });

  it("[tag:s3-upload] stops dispatching new work after the signal aborts", async () => {
    const controller = new AbortController();
    const calls: number[] = [];

    await runWithConcurrency(
      5,
      2,
      async (index) => {
        calls.push(index);
        if (index === 0) controller.abort();
      },
      controller.signal,
    );

    expect(calls).toEqual([0]);
  });

  it("[tag:s3-upload] downloads object text and returns null for missing objects", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "not found",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => "payload",
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getObjectText("bucket", "missing.txt")).resolves.toBeNull();
    await expect(getObjectText("bucket", "found.txt")).resolves.toBe("payload");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://agentstudio.example.com/s3/bucket/missing.txt",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer token-123",
        }),
      }),
    );
  });

  it("[tag:s3-upload] rejects downloads for non-404 failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "server error",
    }));

    await expect(getObjectText("bucket", "broken.txt")).rejects.toThrow(
      "Download failed (500): server error",
    );
  });
});
