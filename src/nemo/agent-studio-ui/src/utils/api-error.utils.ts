import type { FetchBaseQueryError } from "@reduxjs/toolkit/query";

export function extractApiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error !== "object" || error == null) {
    return fallback;
  }

  const fetchError = error as FetchBaseQueryError;
  if ("data" in fetchError && typeof fetchError.data === "object" && fetchError.data != null) {
    const data = fetchError.data as Record<string, unknown>;
    const message = data.message ?? data.error;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
    if (Array.isArray(data.errors)) {
      for (const entry of data.errors) {
        if (typeof entry !== "object" || entry == null) continue;
        const msg = (entry as Record<string, unknown>).msg;
        if (typeof msg === "string" && msg.trim()) {
          return msg.trim();
        }
      }
    }
  }

  if ("error" in fetchError && typeof fetchError.error === "string" && fetchError.error.trim()) {
    return fetchError.error.trim();
  }

  if ("status" in fetchError && fetchError.status != null) {
    return `${fallback} (HTTP ${String(fetchError.status)})`;
  }

  return fallback;
}
