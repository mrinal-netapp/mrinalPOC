import Ajv2020 from 'ajv/dist/2020';

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  validateSchema: true,
});

/**
 * Returns true when `raw` parses to a JSON Schema object (not a boolean or
 * array) that satisfies the JSON Schema meta-schema (draft 2020-12) and
 * compiles under strict mode. Arbitrary JSON objects are rejected.
 */
export function isValidJsonSchemaString(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return false;
  }

  const schema = parsed as Record<string, unknown>;
  const existingId =
    typeof schema.$id === 'string' && schema.$id.trim().length > 0
      ? schema.$id
      : undefined;
  const compileKey = existingId ?? `__ephemeral_${Date.now()}_${Math.random()}`;
  const compileTarget = existingId ? schema : { ...schema, $id: compileKey };
  const hadSchemaBeforeCompile = ajv.getSchema(compileKey) !== undefined;
  try {
    // compile performs meta-schema validation because AJV is configured
    // with validateSchema=true.
    ajv.compile(compileTarget);
    return true;
  } catch {
    return false;
  } finally {
    if (!hadSchemaBeforeCompile) {
      ajv.removeSchema(compileKey);
    }
  }
}
