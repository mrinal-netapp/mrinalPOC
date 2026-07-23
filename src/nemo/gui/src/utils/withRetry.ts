import { isAxiosError } from 'axios'

/** Sleep for ms (jitter optional for thundering herd avoidance). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface WithRetryOptions {
  /** Total attempts including the first try (default 4) */
  maxAttempts?: number
  /** Initial backoff in ms (default 400) */
  baseDelayMs?: number
  /** Cap for exponential backoff (default 8000) */
  maxDelayMs?: number
}

function parseHttpStatusFromMessage(message: string): number | undefined {
  const m = message.match(/status (\d{3})\b/i) || message.match(/\b(\d{3})\b(?=[^\d]*$)/)
  if (m) {
    const n = parseInt(m[1], 10)
    if (n >= 400 && n < 600) return n
  }
  return undefined
}

/** True if the failure is worth retrying (transient network / server pressure). */
export function isRetriableUploadError(err: unknown): boolean {
  if (!err) return false
  if (isAxiosError(err)) {
    const st = err.response?.status
    if (st === 408 || st === 429 || st === 500 || st === 502 || st === 503 || st === 504) {
      return true
    }
    if (!err.response) {
      return true
    }
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    if (
      msg.includes('network error') ||
      msg.includes('failed to fetch') ||
      msg.includes('networkerror') ||
      msg.includes('timeout') ||
      msg.includes('timed out') ||
      msg.includes('aborted') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout')
    ) {
      return true
    }
    const st = parseHttpStatusFromMessage(err.message)
    if (st === 408 || st === 429 || st === 500 || st === 502 || st === 503 || st === 504) {
      return true
    }
  }
  return false
}

/**
 * Retry a function with exponential backoff + jitter on retriable failures.
 */
export async function withRetry<T>(fn: () => Promise<T>, options?: WithRetryOptions): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 4
  const baseDelayMs = options?.baseDelayMs ?? 400
  const maxDelayMs = options?.maxDelayMs ?? 8000
  let last: unknown
  let delay = baseDelayMs

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      if (attempt >= maxAttempts - 1 || !isRetriableUploadError(e)) {
        throw e
      }
      const jitter = Math.random() * 150
      await sleep(delay + jitter)
      delay = Math.min(maxDelayMs, delay * 2)
    }
  }
  throw last
}
