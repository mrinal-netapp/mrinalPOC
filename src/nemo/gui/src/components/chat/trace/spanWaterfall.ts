import { tokens } from '@fluentui/react-components'
import type { TraceSpan } from '../../../services/api'

export function orderSpansForWaterfall(
  spans: TraceSpan[],
): { span: TraceSpan; depth: number }[] {
  const bySpanId = new Map(spans.map((s) => [s.context.span_id, s]))
  const byParent = new Map<string | null, TraceSpan[]>()
  for (const s of spans) {
    const pid = s.parent_id
    const key = pid && bySpanId.has(pid) ? pid : null
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key)!.push(s)
  }
  for (const arr of byParent.values()) {
    arr.sort(
      (a, b) =>
        new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
    )
  }
  const out: { span: TraceSpan; depth: number }[] = []
  function walk(parentKey: string | null, depth: number) {
    const kids = byParent.get(parentKey) || []
    for (const s of kids) {
      out.push({ span: s, depth })
      walk(s.context.span_id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

export function spanDurationMs(s: TraceSpan): number {
  const a = new Date(s.start_time).getTime()
  const b = new Date(s.end_time).getTime()
  return Math.max(0, b - a)
}

export function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${Math.round(ms)}ms`
}

export function kindColor(kind: string): string {
  const k = kind.toUpperCase()
  if (k === 'LLM') return tokens.colorPaletteBlueBackground2
  if (k === 'TOOL') return tokens.colorPaletteGreenBackground2
  if (k === 'AGENT' || k === 'CHAIN') return tokens.colorPalettePurpleBackground2
  if (k === 'RETRIEVER') return tokens.colorPaletteDarkOrangeBackground2
  if (k === 'EMBEDDING') return tokens.colorPaletteTealBackground2
  return tokens.colorNeutralBackground5
}

export function pickAttr(
  attrs: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    if (attrs[k] !== undefined && attrs[k] !== null) {
      return String(attrs[k])
    }
  }
  return null
}
