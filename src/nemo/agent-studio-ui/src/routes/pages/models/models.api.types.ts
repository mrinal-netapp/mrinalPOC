import type { BaseListParams } from "@/api/api.types";

import type { ModelRow, ProviderRow } from "@/components/models/models-overview/models-overview.types";

/*
 * API contract for the Models pages. Kept under `routes/pages/models/`
 * (not `src/api/`) so the model API lives with its page, alongside
 * `model-detail-page.api.ts`. The list-item shapes alias the table row
 * types so there is a single source of truth for a model / provider row.
 *
 * TODO(backend): reconcile these with the real OpenAPI schema once the
 * `/models` and `/providers` contracts land (field names, optionality).
 */

/** Item returned by the models list endpoint. */
type ModelListItem = ModelRow;

/** Item returned by the providers list endpoint. */
type ProviderListItem = ProviderRow;

/** Query params accepted by the models list endpoint. */
type ModelListParams = BaseListParams;

/** Query params accepted by the providers list endpoint. */
type ProviderListParams = BaseListParams;

export type {
  ModelListItem,
  ModelListParams,
  ProviderListItem,
  ProviderListParams,
};
