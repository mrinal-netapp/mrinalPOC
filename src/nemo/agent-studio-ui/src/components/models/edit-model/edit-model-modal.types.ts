import type { SelectDropdownValue } from "@/ui-lib/base-components/select-dropdown/select-dropdown.types";

/** Minimal model shape passed from add-model cards (avoids circular imports). */
type EditModelModalModel = {
  key: string;
  value: string;
  label: string;
};

/**
 * Saved per-model configuration emitted by the modal's Save action. The
 * Add-model page parses these into the `POST /models` body (rpm/tpm/spending
 * + pricing overrides). Values are kept as raw form strings here; numeric
 * parsing + unit normalization happen at the call site.
 */
type EditModelConfig = {
  /** Project-local model name sent as `POST /models` `name`. */
  name: string;
  throttlingTier: string;
  maxRequestsPerMinute: string;
  maxTokensPerMinute: string;
  customPricingEnabled: boolean;
  inputCostUsd: string;
  outputCostUsd: string;
  pricingUnit: string;
  spendingLimitEnabled: boolean;
  spendingLimitUsd: string;
  spendingPeriod: string;
};

/** Public props for the `EditModelModal` component. */
type EditModelModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: EditModelModalModel | null;
  /**
   * Provider id of the model being configured (e.g. `openai`, `azure`). Used to
   * resolve the catalog list price for the Custom pricing hint. Optional so
   * callers without provider context still render the modal (just no hint).
   */
  provider?: string | null;
  /**
   * Previously-saved config for this model, used to seed the form so edits
   * persist across close/reopen. Omitted (or null) for a first-time open, in
   * which case the form starts from defaults.
   */
  initialConfig?: EditModelConfig | null;
  /** Called on Save with the model key + its configured limits/pricing. */
  onSave?: (modelKey: string, config: EditModelConfig) => void;
};

/** Props for the internal collapse-trigger button. */
type CollapseTriggerProps = {
  sectionId: string;
  expanded: boolean;
  title: string;
  onToggle: () => void;
};

/**
 * Form state for `EditModelModalBody`. Driven by a partial-update reducer
 * so every field change is a single `dispatch({ field: value })` call —
 * cheaper to add a field than wiring another `useState` pair, and the
 * whole form is one snapshot for future "reset" / "discard" actions.
 */
type EditModelFormState = {
  name: string;
  throttlingTier: SelectDropdownValue;
  maxRequestsPerMinute: string;
  maxTokensPerMinute: string;
  customPricingOpen: boolean;
  inputCostUsd: string;
  outputCostUsd: string;
  pricingUnit: SelectDropdownValue;
  spendingLimitOpen: boolean;
  spendingLimitUsd: string;
  spendingPeriod: SelectDropdownValue;
};

export type {
  CollapseTriggerProps,
  EditModelConfig,
  EditModelFormState,
  EditModelModalModel,
  EditModelModalProps,
};
