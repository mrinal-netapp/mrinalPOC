import type { ModelPricingDefaults } from "@/routes/pages/models/models.api"

import type { ModelDetail } from "../../model-detail-page.types"

type TimeRangeOption = "Last week" | "Last month" | "Last 3 months" | "Last 6 months"

type OverviewPanelProps = {
  model: ModelDetail
  /** Number of resources (agents, KBs, …) that reference this model. */
  dependentCount?: number
  /**
   * Provider list (catalog) pricing per 1M tokens. Used as the fallback price
   * shown when the model has no custom override for a given field.
   */
  pricingDefaults?: ModelPricingDefaults
}

export type { OverviewPanelProps, TimeRangeOption }
