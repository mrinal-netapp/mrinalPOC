/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
  /** Override Prometheus `namespace=` label (default agentstudio if workloads use that namespace). */
  readonly VITE_K8S_METRICS_NAMESPACE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}




