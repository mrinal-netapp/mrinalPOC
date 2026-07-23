/**
 * Standard error response format
 */
export interface ErrorResponse {
  error: string;
  code: string;
  details?: any;
}

/**
 * Health check response
 */
export interface HealthResponse {
  status: 'healthy' | 'unhealthy';
  timestamp?: string;
}

/**
 * Readiness check response
 */
export interface ReadyResponse {
  status: 'ready' | 'not ready';
  timestamp?: string;
}

