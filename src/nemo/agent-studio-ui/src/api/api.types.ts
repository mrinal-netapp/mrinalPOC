// Shared types used across all API slices.
// Domain-specific types live in their own files (e.g. data-source.types.ts).

// -- Error types --

export interface ErrorDetail {
  field: string;
  message: string;
}

export interface ErrorResponse {
  error: string;
  details?: ErrorDetail[];
}

export interface ConflictError {
  error: string;
  datasets_count: number;
  pipelines_count: number;
  agents_count: number;
}

// -- Pagination --

export interface Pagination {
  limit: number;
  offset: number;
  total_count: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: Pagination;
}

export interface PaginationParams {
  limit?: number;
  offset?: number;
}

// -- Sort & Search --

export type SortOrder = 'asc' | 'desc';

export interface SortParams {
  sort_by?: string;
  sort_order?: SortOrder;
}

export interface SearchParams {
  search?: string;
}

// -- Base resource --

export interface BaseResource {
  name: string;
  labels: string[];
  created_at: string;
  updated_at: string;
}

// -- Base request --

// Extends mutation/query args to let callers opt out of global error handling
// (e.g. inline form validation) once the error-boundary middleware is wired.
export interface ApiRequest {
  isSelfHandleErrors?: boolean;
}

// -- Name validation --

export interface NameValidateRequest {
  name: string;
}

export interface NameValidateResponse {
  name: string;
  available: boolean;
}

// -- Deprecation (shared request shape; responses are domain-specific) --

export interface DeprecationRequest {
  deprecated: boolean;
}

// -- List query base --

export type BaseListParams = PaginationParams & SortParams & SearchParams;

// -- Schedule config base --

export interface ScheduleConfig {
  schedule_type?: string | null;
  interval_minutes?: number | null;
  time_of_day?: string | null;
  day_of_week?: number[] | null;
  day_of_month?: number | null;
  cron_expression?: string | null;
}
