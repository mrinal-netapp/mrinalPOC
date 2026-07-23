interface RuntimeConfig {
  grafanaUrl: string
  jaegerUrl: string
  /** K8s namespace for kube-state-metrics / cAdvisor PromQL filters (Helm sets NAMESPACE on the GUI pod). */
  k8sMetricsNamespace: string
}

/**
 * Reads runtime configuration injected by the container entrypoint via
 * an inline script that sets window.__RUNTIME_CONFIG__. Falls back
 * gracefully in local dev where the inline script is not present.
 */
export function getRuntimeConfig(): RuntimeConfig {
  const config = (window as any).__RUNTIME_CONFIG__ || {}
  return {
    grafanaUrl: config.grafanaUrl || '',
    jaegerUrl: config.jaegerUrl || '',
    k8sMetricsNamespace: (config.k8sMetricsNamespace as string) || '',
  }
}
