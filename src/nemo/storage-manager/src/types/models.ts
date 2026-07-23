// GetRoutingInfoResponse contains routing information
export interface GetRoutingInfoResponse {
  is_local: boolean;
  redirect_url: string;
  serving_deployments: string[];
  role: 'primary' | 'secondary';
}

// HealthCheckResponse contains health status
export interface HealthCheckResponse {
  healthy: boolean;
  status_message: string;
  last_config_sync: number;
}

// ErrorResponse represents an error response
export interface ErrorResponse {
  error: string;
  code?: string;
}

// Metrics represents metrics data
export interface Metrics {
  source: 'api_gateway' | 'volume_manager';
  timestamp: string;
  metrics?: {
    request_latency_p50_ms?: number;
    request_latency_p95_ms?: number;
    request_latency_p99_ms?: number;
    requests_per_second?: number;
    error_rate?: number;
  };
  bucket_metrics?: Record<string, {
    requests?: number;
    errors?: number;
  }>;
}

