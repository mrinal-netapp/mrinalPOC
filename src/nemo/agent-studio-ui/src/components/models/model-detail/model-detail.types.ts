/*
 * Detail shape kept local until the real `/models/{id}` contract lands.
 * See the TODO(backend) marker inside `ModelDetail` for the hook-up point.
 */

/** Lifecycle status of a registered model. */
type ModelStatus = "Active" | "Inactive" | "Failed";

/** Detail-page view shape. */
type ModelDetailRow = {
  model_id: string;
  name: string;
  type: "LLM" | "Embedding" | "Vision" | "Reranker";
  provider_name: string;
  status: ModelStatus;
  context_window: number;
  version: string;
  description: string;
};

export type { ModelDetailRow, ModelStatus };
