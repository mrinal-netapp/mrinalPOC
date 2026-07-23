/**
 * Key-order-independent JSON value comparison for config objects on PUT update
 * paths. JSONB round-trips do not preserve object key order, so stringify-based
 * checks can falsely report changes and trigger unnecessary workflows.
 */
export function jsonFieldEqual(a: unknown, b: unknown): boolean {
  return deepJsonEqual(a ?? null, b ?? null);
}

function deepJsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  if (a === null || b === null) {
    return a === b;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!deepJsonEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj).filter((key) => aObj[key] !== undefined);
  const bKeys = Object.keys(bObj).filter((key) => bObj[key] !== undefined);
  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
    if (!deepJsonEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}
