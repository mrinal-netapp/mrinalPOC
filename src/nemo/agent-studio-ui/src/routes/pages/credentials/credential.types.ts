export interface DependentsSummary {
  total: number;
  byKind: Record<string, number>;
}

export interface Credential {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  provider: string;
  /** JSONB on the backend — values may be any JSON type, not just strings. */
  metadata?: Record<string, unknown>;
  labels?: string[];
  expiresAt?: string;
  lastRotatedAt?: string;
  rotationVersion?: number;
  dependentsSummary?: DependentsSummary;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialCreateRequest {
  name: string;
  description?: string;
  provider: string;
  secretData: Record<string, string>;
  metadata?: Record<string, string>;
  labels?: string[];
  expiresAt?: string;
}

export interface CredentialUpdateRequest {
  name?: string;
  description?: string;
  metadata?: Record<string, string>;
  labels?: string[];
  expiresAt?: string;
}

export interface CredentialRotateRequest {
  secretData: Record<string, string>;
  expiresAt?: string;
}

export interface CredentialValidateResponse {
  valid: boolean;
  error?: string;
}

export interface CredentialListParams {
  provider?: string;
  labels?: string;
}
