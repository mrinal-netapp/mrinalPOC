// -- Browse API --

export interface BrowseParams {
  datasourceId: string;
  path?: string;
  limit?: number;
  continuationToken?: string;
}

export interface BrowseItem {
  name: string;
  path: string;
  type: string;
  size: number;
  lastModified: number;
}

export interface BrowseResponse {
  path: string;
  items: BrowseItem[];
  totalItems: number;
  limit: number;
  nextContinuationToken?: string;
}

// -- Validate Connection --

export type ConnectionHealthiness = 'Healthy' | 'Unhealthy';

// -- Request (discriminated union on `type`, mirrors BE ValidateConnectionRequestDto) --

export type ValidateConnectionRequestNfs = {
  type: 'NFS';
  server: string;
  folderBoundary: string[];
};

export type ValidateConnectionRequestSmb = {
  type: 'SMB';
  server: string;
  folderBoundary: string[];
  credentialsRef: string;
};

export type ValidateConnectionRequestS3 = {
  type: 'S3';
  server: string;
  folderBoundary: string[];
  credentialsRef: string;
};

export type ValidateConnectionRequest =
  | ValidateConnectionRequestNfs
  | ValidateConnectionRequestSmb
  | ValidateConnectionRequestS3;

// -- Response --

export interface ValidateConnectionResponse {
  healthiness_status: ConnectionHealthiness;
  last_validation_error?: string;
}
