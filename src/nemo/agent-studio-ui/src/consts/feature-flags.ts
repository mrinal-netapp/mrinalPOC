function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return fallback;
}

/**
 * Feature flags for incomplete Agents detail sections.
 *
 * Defaults stay `false` so unfinished UI remains hidden unless explicitly
 * enabled via env in a dev/internal environment.
 */
export const FEATURE_AGENT_CONFIGURATIONS_TAB = parseBooleanFlag(
  import.meta.env.VITE_FEATURE_AGENT_CONFIGURATIONS_TAB,
  false,
);

export const FEATURE_AGENT_METRICS_ROW = parseBooleanFlag(
  import.meta.env.VITE_FEATURE_AGENT_METRICS_ROW,
  false,
);
