export function formatDollars(val: number): string {
  if (val >= 1000) return `$${(val / 1000).toFixed(1)}K`
  if (val >= 1) return `$${val.toFixed(2)}`
  if (val >= 0.01) return `$${val.toFixed(3)}`
  return `$${val.toFixed(4)}`
}

export function formatTokens(val: number): string {
  if (val >= 1e9) return `${(val / 1e9).toFixed(1)}B`
  if (val >= 1e6) return `${(val / 1e6).toFixed(1)}M`
  if (val >= 1e3) return `${(val / 1e3).toFixed(1)}K`
  return val.toFixed(0)
}

export function formatCount(val: number): string {
  if (val >= 1e6) return `${(val / 1e6).toFixed(1)}M`
  if (val >= 1e3) return `${(val / 1e3).toFixed(1)}K`
  return val.toFixed(0)
}
