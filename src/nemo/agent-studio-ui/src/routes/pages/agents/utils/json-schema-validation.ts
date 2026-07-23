import Ajv2020 from "ajv/dist/2020"

// Reuse one AJV instance — structured-output validation runs on dialog
// re-renders/keystrokes and constructing AJV per call is wasteful.
const ajv = new Ajv2020({
  // Reject unknown/typoed keywords so we accept true JSON Schema docs,
  // not arbitrary JSON objects.
  strict: true,
  allErrors: true,
  validateSchema: true,
})

type ParsedJsonSchema =
  | { ok: true; schema: Record<string, unknown> }
  | { ok: false }

function parseJsonSchemaObject(raw: string): ParsedJsonSchema {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false }

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false }
    }
    return { ok: true, schema: parsed as Record<string, unknown> }
  } catch {
    return { ok: false }
  }
}

function isValidJsonSchemaDocument(schema: Record<string, unknown>): boolean {
  const existingId =
    typeof schema.$id === "string" && schema.$id.trim().length > 0
      ? schema.$id
      : undefined
  // Only inject an ephemeral $id when the schema lacks one so user-declared
  // $id values used for $ref resolution are not overwritten.
  const compileKey = existingId ?? `__ephemeral_${Date.now()}_${Math.random()}`
  const compileTarget = existingId ? schema : { ...schema, $id: compileKey }
  const hadSchemaBeforeCompile = ajv.getSchema(compileKey) !== undefined
  try {
    // compile performs meta-schema validation because AJV is configured
    // with validateSchema=true; strict mode rejects non-schema objects.
    ajv.compile(compileTarget)
    return true
  } catch {
    return false
  } finally {
    // Only drop schemas this call added — never remove pre-existing/meta ids.
    if (!hadSchemaBeforeCompile) {
      ajv.removeSchema(compileKey)
    }
  }
}

function isValidJsonSchema(raw: string): boolean {
  const parsed = parseJsonSchemaObject(raw)
  if (!parsed.ok) return false
  return isValidJsonSchemaDocument(parsed.schema)
}

function parseAndValidateJsonSchema(raw: string): Record<string, unknown> | null {
  const parsed = parseJsonSchemaObject(raw)
  if (!parsed.ok) return null
  return isValidJsonSchemaDocument(parsed.schema) ? parsed.schema : null
}

type StructuredOutputValidationResult =
  | { ok: true }
  | { ok: false; reason: "empty" | "invalid" }

const STRUCTURED_OUTPUT_SAVE_ERRORS = {
  jsonSchemaRequired: "JSON schema is required when Structured output is enabled.",
  jsonSchemaInvalid:
    "Structured output schema must be a valid JSON Schema object when Structured output is enabled.",
  guidelinesRequired: "Response guidelines are required when Structured output is enabled.",
} as const

function validateStructuredOutputSchema(
  raw: string,
  responseFormat: "text" | "json_object",
): StructuredOutputValidationResult {
  const trimmed = raw.trim()
  if (responseFormat === "text") {
    return trimmed ? { ok: true } : { ok: false, reason: "empty" }
  }
  if (!trimmed) return { ok: false, reason: "empty" }
  return isValidJsonSchema(trimmed) ? { ok: true } : { ok: false, reason: "invalid" }
}

function getStructuredOutputSaveError(
  raw: string,
  responseFormat: "text" | "json_object",
): string | undefined {
  const result = validateStructuredOutputSchema(raw, responseFormat)
  if (result.ok) return undefined
  if (responseFormat === "text") return STRUCTURED_OUTPUT_SAVE_ERRORS.guidelinesRequired
  return result.reason === "empty"
    ? STRUCTURED_OUTPUT_SAVE_ERRORS.jsonSchemaRequired
    : STRUCTURED_OUTPUT_SAVE_ERRORS.jsonSchemaInvalid
}

export {
  getStructuredOutputSaveError,
  isValidJsonSchema,
  parseAndValidateJsonSchema,
  STRUCTURED_OUTPUT_SAVE_ERRORS,
  validateStructuredOutputSchema,
}

