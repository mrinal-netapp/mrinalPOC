import type { ReactElement } from "react";

import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { useGetModelPricingDefaultsQuery } from "@/routes/pages/models/models.api";
import { Typography } from "@/ui-lib/base-components/typography/typography";

type ModelCostCellProps = {
  /** config-service provider id (e.g. "openai"), used to resolve list pricing. */
  providerId?: string;
  /** Provider's own model id (e.g. "gpt-4o"), used to resolve list pricing. */
  providerModelId?: string;
  /** Custom override (USD per 1M tokens). When set it wins over the default. */
  customCost?: number | null;
  /** Which side of the price to show when falling back to the catalog default. */
  costType: "input" | "output";
};

/** Format a per-1M-token price (USD) for display; "-" when unavailable. */
function formatPer1M(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "-";
  return `$${value.toFixed(2)}`;
}

/**
 * Renders a model's effective per-1M-token price: the custom override when the
 * model has one, otherwise the provider list (catalog) price resolved from the
 * `/models/pricing-defaults` endpoint. The default lookup is skipped entirely
 * when a custom price is present (or the provider/model is unknown), so most
 * rows make no extra request.
 */
function ModelCostCell({
  providerId,
  providerModelId,
  customCost,
  costType,
}: ModelCostCellProps): ReactElement {
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const hasCustom = typeof customCost === "number" && !Number.isNaN(customCost);

  const { data: pricing, isFetching } = useGetModelPricingDefaultsQuery(
    {
      projectId: projectId ?? "",
      provider: providerId ?? "",
      model: providerModelId ?? "",
    },
    {
      skip:
        hasCustom ||
        !projectId ||
        !providerId ||
        !providerModelId,
    },
  );

  let value: string;
  if (hasCustom) {
    value = formatPer1M(customCost);
  } else if (isFetching && !pricing) {
    value = "…";
  } else {
    value = formatPer1M(
      costType === "input" ? pricing?.inputCostPer1M : pricing?.outputCostPer1M,
    );
  }

  return (
    <Typography Component="span" fontSize="fs14" color="var(--text-secondary)">
      {value}
    </Typography>
  );
}

export { ModelCostCell };
export type { ModelCostCellProps };
