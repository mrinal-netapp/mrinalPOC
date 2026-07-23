/** Builds a TanStack Form field path, optionally nested under a prefix. */
export function agentFormFieldPath(prefix: string | undefined, field: string): string {
  return prefix ? `${prefix}.${field}` : field;
}

/** Template member/manager cards store profile name under `template.*`.name. */
export function isTemplateInstanceFieldPrefix(prefix: string | undefined): boolean {
  return Boolean(prefix?.startsWith("template."));
}

/** Reads a nested value from form state using dot/bracket paths. */
export function getFormValueAtPath<T>(values: unknown, path: string): T | undefined {
  const normalized = path.replace(/\[(\d+)\]/g, ".$1");
  let current: unknown = values;
  for (const segment of normalized.split(".")) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current as T | undefined;
}
