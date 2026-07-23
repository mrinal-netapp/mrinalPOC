/**
 * Catalog item shown in the model picker dropdown and on each
 * `SelectedModelCard`. `kind` controls grouping (LLM vs embedding).
 */
type ModelCatalogItem = {
  key: string;
  value: string;
  label: string;
  /** Distinguishes LLM vs embedding rows when building the flat model list. */
  kind: "llm" | "embedding";
};

/**
 * Row shape for the providers table on the Add Model page. Kept local to
 * this folder rather than in `ui/src/api/model.types.ts` so the page owns
 * its own contract until the real `/providers` endpoint lands — see the
 * matching TODO(backend) marker inside `AddModel`.
 */
type ModelProvider = {
  provider_id: string;
  name: string;
  capabilities: string;
  data_residency: string;
};

/** Column the providers table is currently sorted by. */
type ProviderSortColumn = "name" | "capabilities" | "data_residency";

/**
 * Tri-state sort: `null` = unsorted, otherwise the active column and
 * direction. Clicking the same column cycles asc → desc → null.
 */
type ProviderSortState =
  | {
      column: ProviderSortColumn;
      direction: "asc" | "desc";
    }
  | null;

export type { ModelCatalogItem, ModelProvider, ProviderSortColumn, ProviderSortState };
