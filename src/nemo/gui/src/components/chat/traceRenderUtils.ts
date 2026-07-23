/**
 * Span attributes from Phoenix are loosely typed (Record<string, unknown>).
 * OpenInference often stores LLM I/O as JSON strings — sometimes nested / double-encoded.
 */

/**
 * Recursively parse string values that contain JSON (`{...}` / `[...]`) so
 * pretty-printed attributes show real nested structure instead of one long escaped string.
 */
export function deepParseJsonStringValues(
  input: unknown,
  depth = 0,
  maxDepth = 6,
): unknown {
  if (depth >= maxDepth) return input
  if (input === null || input === undefined) return input
  if (Array.isArray(input)) {
    return input.map((item) => deepParseJsonStringValues(item, depth + 1, maxDepth))
  }
  if (typeof input === 'object') {
    const o = input as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(o)) {
      out[k] = deepParseJsonStringValues(v, depth + 1, maxDepth)
    }
    return out
  }
  if (typeof input === 'string') {
    const t = input.trim()
    if (!t) return input
    if (
      (t.startsWith('{') && t.endsWith('}')) ||
      (t.startsWith('[') && t.endsWith(']'))
    ) {
      try {
        const parsed = JSON.parse(input)
        return deepParseJsonStringValues(parsed, depth + 1, maxDepth)
      } catch {
        return input
      }
    }
  }
  return input
}

export function unwrapJsonStringLayers(input: unknown, maxDepth = 8): unknown {
  let v: unknown = input
  let depth = 0
  while (depth < maxDepth && typeof v === 'string') {
    const t = v.trim()
    if (!t) break
    if (!(t.startsWith('{') || t.startsWith('['))) break
    try {
      v = JSON.parse(v)
      depth += 1
    } catch {
      break
    }
  }
  return v
}

export interface ChatMessageLike {
  role: string
  content: string
}

/** Typical OpenInference shape: { messages: [{ role, content }, ...] } */
export function tryExtractOpenInferenceMessages(obj: unknown): ChatMessageLike[] | null {
  if (obj === null || typeof obj !== 'object') return null
  const messages = (obj as Record<string, unknown>).messages
  if (!Array.isArray(messages)) return null
  const out: ChatMessageLike[] = []
  for (const item of messages) {
    if (!item || typeof item !== 'object') continue
    const m = item as Record<string, unknown>
    const role = typeof m.role === 'string' ? m.role : 'message'
    const content = m.content
    if (typeof content === 'string') {
      out.push({ role, content })
    }
  }
  return out.length > 0 ? out : null
}

export function stringifyForRaw(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

const MD_HINT = /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|(\d+)\.\s|```)/

export function looksLikeMarkdown(s: string): boolean {
  return MD_HINT.test(s) || (s.includes('**') && s.includes('\n'))
}

/** Offset of span start from trace start (ms), for timeline attribution. */
export function formatOffsetMs(offsetMs: number): string {
  if (offsetMs < 0) return `${offsetMs.toFixed(0)}ms`
  if (offsetMs < 1000) return `+${Math.round(offsetMs)}ms`
  return `+${(offsetMs / 1000).toFixed(2)}s`
}

export interface AxisTick {
  pct: number
  label: string
}

/** Labels for horizontal timeline ruler (0% … 100% of trace duration). */
export function formatAxisTicks(totalMs: number, tickCount = 5): AxisTick[] {
  const t = Math.max(1, totalMs)
  const ticks: AxisTick[] = []
  for (let i = 0; i < tickCount; i++) {
    const pct = (i / (tickCount - 1)) * 100
    const ms = (i / (tickCount - 1)) * t
    ticks.push({
      pct,
      label: ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`,
    })
  }
  return ticks
}

/** Local date/time string for span start/end. */
export function formatAbsoluteTime(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, {
      dateStyle: 'short',
      timeStyle: 'medium',
    })
  } catch {
    return iso
  }
}
