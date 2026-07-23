/**
 * RFC-4122 UUID (versions 1-5) matcher, used to guard lookups against UUID
 * primary keys so a malformed id is rejected with a 400 before it reaches
 * Postgres (which would otherwise throw `invalid input syntax for type uuid`,
 * surfacing as a 500).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
