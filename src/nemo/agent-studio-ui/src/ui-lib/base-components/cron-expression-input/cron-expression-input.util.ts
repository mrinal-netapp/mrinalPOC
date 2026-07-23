/**
 * 5-field Unix-style cron: minute, hour, day of month, month, day of week.
 * Supports * wildcards, step (star-slash-N), n, n-m, n-m with step, and comma lists (e.g. 0,5,10).
 * Day of week: 0 (Sunday) through 6 (Saturday); numeric only (no month names in this pass).
 */

const CRON_FIELD_NAMES = [
  "Minute",
  "Hour",
  "Day of month",
  "Month",
  "Day of week",
] as const

const CRON_LIMITS: readonly { min: number; max: number; maxStep: number }[] = [
  { min: 0, max: 59, maxStep: 59 },
  { min: 0, max: 23, maxStep: 23 },
  { min: 1, max: 31, maxStep: 31 },
  { min: 1, max: 12, maxStep: 12 },
  { min: 0, max: 6, maxStep: 7 },
] as const

const STRUCTURE_ERROR =
  "Use five space-separated parts: minute, hour, day of month, month, and day of week (for example, 0 10 * * *)."

/**
 * Resolves the string value for `@tanstack/react-form` field `onBlur` / `onChange` validators
 * (they receive an object with `value`, or in edge cases a primitive).
 */
function valueFromFieldValidatorParam(param: unknown): string {
  if (param == null) {
    return ""
  }
  if (typeof param === "string" || typeof param === "number" || typeof param === "boolean") {
    return String(param)
  }
  if (typeof param === "object" && "value" in (param as object)) {
    const v = (param as { value: unknown }).value
    if (v == null) {
      return ""
    }
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      return String(v)
    }
    return String(v)
  }
  return ""
}

/**
 * Returns the first validation error, or `undefined` when the expression is valid.
 */
function validateCronExpression(value: string): string | undefined {
  const t = value.trim()
  if (t === "") {
    return "Enter a cron expression."
  }

  const topParts = t.split(/\s+/).filter((p) => p.length > 0)
  if (topParts.length !== 5) {
    return topParts.length < 5 ? STRUCTURE_ERROR : "Too many fields. Use exactly five space-separated values."
  }

  for (let i = 0; i < 5; i += 1) {
    const err = validateCronFieldValue(topParts[i]!, i)
    if (err) {
      return err
    }
  }
  return undefined
}

function validateCronFieldValue(field: string, fieldIndex: number): string | undefined {
  const name = CRON_FIELD_NAMES[fieldIndex]!
  const { min, max, maxStep } = CRON_LIMITS[fieldIndex]!
  const segments = field
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (segments.length === 0) {
    return `${name}: this field is empty.`
  }

  const hasMultiple = segments.length > 1
  for (const seg of segments) {
    if (hasMultiple && seg === "*") {
      return `${name}: * cannot be combined with other values in the same field.`
    }
    const err = validateSegment(seg, { name, min, max, maxStep })
    if (err) {
      return err
    }
  }
  return undefined
}

function validateSegment(
  seg: string,
  o: { name: string; min: number; max: number; maxStep: number },
): string | undefined {
  if (seg === "*") {
    return undefined
  }

  if (seg.startsWith("*/")) {
    const rest = seg.slice(2)
    if (rest === "" || !/^\d+$/.test(rest)) {
      return `${o.name}: invalid step. Use a form like */5, where the number is between 1 and ${o.maxStep}.`
    }
    const n = parseInt(rest, 10)
    if (n < 1) {
      return `${o.name}: step must be at least 1; */0 is not valid.`
    }
    if (n > o.maxStep) {
      return `${o.name}: step must be at most ${o.maxStep} for this field.`
    }
    return undefined
  }

  if (/^\d+$/.test(seg)) {
    const n = parseInt(seg, 10)
    if (n < o.min || n > o.max) {
      return `${o.name}: use ${o.min} to ${o.max} ("${seg}" is out of range).`
    }
    return undefined
  }

  const m = seg.match(/^(\d+)-(\d+)(?:\/(\d+))?$/)
  if (m) {
    const a = parseInt(m[1]!, 10)
    const b = parseInt(m[2]!, 10)
    const c = m[3] != null ? parseInt(m[3], 10) : undefined
    if (a < o.min || a > o.max || b < o.min || b > o.max) {
      return `${o.name}: in ranges, use ${o.min} to ${o.max} only.`
    }
    if (a > b) {
      return `${o.name}: use an increasing range (for example, 0–3), not a descending one.`
    }
    if (c != null) {
      if (c < 1 || c > o.maxStep) {
        return `${o.name}: range step (after /) must be between 1 and ${o.maxStep}.`
      }
    }
    return undefined
  }

  return `${o.name}: "${seg}" is not valid. Use *, */n, a number, a range, or a comma list.`
}

export { validateCronExpression, valueFromFieldValidatorParam, CRON_FIELD_NAMES, CRON_LIMITS }
