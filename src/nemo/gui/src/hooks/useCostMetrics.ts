import { usePrometheusQuery, usePrometheusRangeQuery, type TimeRange } from './usePrometheusQuery'

/** Bifrost Prometheus metrics (https://docs.getbifrost.ai/features/telemetry). */
export function useCostOverview(timeRange: TimeRange) {
  const window = `${timeRange.seconds}s`
  const totalSpend = usePrometheusQuery(
    `sum(increase(bifrost_cost_total[${window}]))`,
  )
  const totalRequests = usePrometheusQuery(
    `sum(increase(bifrost_upstream_requests_total[${window}]))`,
  )
  const totalInputTokens = usePrometheusQuery(
    `sum(increase(bifrost_input_tokens_total[${window}]))`,
  )
  const totalOutputTokens = usePrometheusQuery(
    `sum(increase(bifrost_output_tokens_total[${window}]))`,
  )

  return {
    totalSpend,
    totalRequests,
    totalInputTokens,
    totalOutputTokens,
    loading:
      totalSpend.loading ||
      totalRequests.loading ||
      totalInputTokens.loading ||
      totalOutputTokens.loading,
  }
}

export function useCostByModel(timeRange: TimeRange) {
  const window = `${timeRange.seconds}s`
  const spendByModel = usePrometheusQuery(
    `sum by (model) (increase(bifrost_cost_total[${window}]))`,
  )
  const requestsByModel = usePrometheusQuery(
    `sum by (model) (increase(bifrost_upstream_requests_total[${window}]))`,
  )
  const tokensByModel = usePrometheusQuery(
    `sum by (model) (increase(bifrost_input_tokens_total[${window}])) + sum by (model) (increase(bifrost_output_tokens_total[${window}]))`,
  )

  return {
    spendByModel,
    requestsByModel,
    tokensByModel,
  }
}

export function useCostRangeQueries(timeRange: TimeRange) {
  const spendOverTime = usePrometheusRangeQuery(
    'sum(rate(bifrost_cost_total[5m])) by (model)',
    timeRange,
  )
  const requestsOverTime = usePrometheusRangeQuery(
    'sum(rate(bifrost_upstream_requests_total[5m])) by (model)',
    timeRange,
  )
  const tokensOverTime = usePrometheusRangeQuery(
    'sum(rate(bifrost_input_tokens_total[5m])) by (model) + sum(rate(bifrost_output_tokens_total[5m])) by (model)',
    timeRange,
  )
  const latencyOverTime = usePrometheusRangeQuery(
    'histogram_quantile(0.95, sum(rate(bifrost_upstream_latency_seconds_bucket[5m])) by (model, le))',
    timeRange,
  )
  const failuresOverTime = usePrometheusRangeQuery(
    'sum(rate(bifrost_error_requests_total[5m])) by (model)',
    timeRange,
  )

  return {
    spendOverTime,
    requestsOverTime,
    tokensOverTime,
    latencyOverTime,
    failuresOverTime,
  }
}
