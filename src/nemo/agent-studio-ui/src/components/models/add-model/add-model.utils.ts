import type {
  SelectDropdownItemData,
  SelectDropdownItemGroup,
} from "@/ui-lib/base-components/select-dropdown/select-dropdown.types";
import type { EditModelConfig } from "@/components/models/edit-model/edit-model-modal.types";
import type { CreateModelRequest } from "@/routes/pages/models/models.api";

import type {
  ModelCatalogItem,
  ModelProvider,
  ProviderSortColumn,
  ProviderSortState,
} from "./add-model.types";

/**
 * Split a model catalog into SelectDropdown data with two sections — "LLM"
 * and "Embedding". `items` is the flat fallback (LLMs first) for consumers
 * that don't render groups; `groups` drives the sectioned dropdown and omits
 * a section entirely when it has no models.
 */
function buildModelDropdownData(catalog: readonly ModelCatalogItem[]): {
  items: SelectDropdownItemData[];
  groups: SelectDropdownItemGroup[];
} {
  const llm: SelectDropdownItemData[] = [];
  const embedding: SelectDropdownItemData[] = [];
  for (const m of catalog) {
    const row: SelectDropdownItemData = { key: m.key, value: m.value, label: m.label };
    if (m.kind === "embedding") {
      embedding.push(row);
    } else {
      llm.push(row);
    }
  }

  const groups: SelectDropdownItemGroup[] = [];
  if (llm.length > 0) groups.push({ key: "llm", label: "LLM", items: llm });
  if (embedding.length > 0) {
    groups.push({ key: "embedding", label: "Embedding", items: embedding });
  }

  return { items: [...llm, ...embedding], groups };
}

function sortProviderRows(
  rows: readonly ModelProvider[],
  sort: ProviderSortState,
): ModelProvider[] {
  if (sort == null) {
    return [...rows];
  }
  return [...rows].sort((a, b) => {
    const va = sort.column === "name" ? a.name : sort.column === "capabilities" ? a.capabilities : a.data_residency;
    const vb = sort.column === "name" ? b.name : sort.column === "capabilities" ? b.capabilities : b.data_residency;
    const cmp = va.localeCompare(vb, undefined, { numeric: true, sensitivity: "base" });
    return sort.direction === "asc" ? cmp : -cmp;
  });
}

function providerColumnAriaSort(
  column: ProviderSortColumn,
  sort: ProviderSortState,
): "ascending" | "descending" | "none" {
  if (sort == null || sort.column !== column) {
    return "none";
  }
  return sort.direction === "asc" ? "ascending" : "descending";
}

const CARD_USD_FORMAT = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 0,
  maximumFractionDigits: 4,
});

/** `$<amount>` with up to 4 decimals; trims float noise from unit scaling. */
function formatCardUsd(value: number): string {
  return `$${CARD_USD_FORMAT.format(value)}`;
}

type SelectedModelCardDetail = { label: string; value: string };

/**
 * Ordered detail rows shown on a selected-model card. Reuses
 * `configToModelLimits` so the displayed pricing / throttling values are
 * normalised exactly like the values submitted to `POST /models` (costs
 * per-1M tokens, positive-only rpm/tpm). Rows without a saved value get an
 * empty string so the card can render its placeholder. The spending-limit
 * row is appended only when a budget is set.
 */
function buildSelectedModelCardDetails(
  model: ModelCatalogItem,
  config?: EditModelConfig,
): SelectedModelCardDetail[] {
  const limits = configToModelLimits(config);
  const details: SelectedModelCardDetail[] = [
    { label: "Name", value: resolveModelRegistrationName(model, config) },
    { label: "Type", value: model.kind === "embedding" ? "Embedding" : "LLM" },
    { label: "Model", value: model.label?.trim() || String(model.value) },
    {
      label: "Input cost per 1M tokens",
      value: limits.inputCostPer1M != null ? formatCardUsd(limits.inputCostPer1M) : "",
    },
    {
      label: "Output cost per 1M tokens",
      value: limits.outputCostPer1M != null ? formatCardUsd(limits.outputCostPer1M) : "",
    },
    {
      label: "Maximum requests per minute",
      value: limits.rpm != null ? String(limits.rpm) : "",
    },
    {
      label: "Maximum tokens per minute",
      value: limits.tpm != null ? String(limits.tpm) : "",
    },
  ];

  if (limits.spendingLimit != null) {
    const period =
      limits.spendingLimitPeriod === "day"
        ? "day"
        : limits.spendingLimitPeriod === "week"
          ? "week"
          : "month";
    details.push({
      label: "Spending limit",
      value: `${formatCardUsd(limits.spendingLimit)} / ${period}`,
    });
  }

  return details;
}

/**
 * Project-local registration name. The Modify dialog's Name field overrides
 * the catalog/deployment label when the user saved a config.
 */
function resolveModelRegistrationName(
  model: ModelCatalogItem,
  config?: EditModelConfig,
): string {
  const fromConfig = config?.name?.trim();
  if (fromConfig) return fromConfig;
  return model.label.trim() || String(model.value);
}

/**
 * Map a saved EditModel config onto the governance + pricing fields of the
 * POST /models body. Only positive, parseable values are included so we never
 * send 0 / NaN. Costs are normalized to per-1M tokens (the API + Bifrost unit).
 */
function configToModelLimits(
  cfg: EditModelConfig | undefined,
): Partial<CreateModelRequest> {
  if (!cfg) return {};
  const out: Partial<CreateModelRequest> = {};

  if (cfg.throttlingTier === "custom") {
    const rpm = Number.parseInt(cfg.maxRequestsPerMinute, 10);
    if (Number.isFinite(rpm) && rpm > 0) out.rpm = rpm;
    const tpm = Number.parseInt(cfg.maxTokensPerMinute, 10);
    if (Number.isFinite(tpm) && tpm > 0) out.tpm = tpm;
  }

  if (cfg.spendingLimitEnabled) {
    const limit = Number.parseFloat(cfg.spendingLimitUsd.replace(/,/g, ""));
    if (Number.isFinite(limit) && limit > 0) {
      out.spendingLimit = limit;
      out.spendingLimitPeriod =
        cfg.spendingPeriod === "per-day"
          ? "day"
          : cfg.spendingPeriod === "per-week"
            ? "week"
            : "month";
    }
  }

  if (cfg.customPricingEnabled) {
    const unitScale = cfg.pricingUnit === "per-1k" ? 1000 : 1;
    const input = Number.parseFloat(cfg.inputCostUsd.replace(/,/g, ""));
    if (Number.isFinite(input) && input >= 0) out.inputCostPer1M = input * unitScale;
    const output = Number.parseFloat(cfg.outputCostUsd.replace(/,/g, ""));
    if (Number.isFinite(output) && output >= 0) out.outputCostPer1M = output * unitScale;
  }

  return out;
}

export {
  buildModelDropdownData,
  buildSelectedModelCardDetails,
  configToModelLimits,
  providerColumnAriaSort,
  resolveModelRegistrationName,
  sortProviderRows,
};
export type { SelectedModelCardDetail };
