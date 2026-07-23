export interface BucketFormData {
  name: string
  region: string
  protocol: string
  
  // NEW: Provisioning mode
  provisioningMode: 'static' | 'dynamic'
  
  // Existing volume fields (static)
  volumeType: string
  volumeEndpoint: string
  mountOptions: string[]
  
  // NEW: Dynamic provisioning fields
  storageClassName?: string
  storageSize?: string
  volumeParameters?: Array<{ key: string; value: string }>
  
  // Common fields
  authType: string
  authUsername: string
  authPassword: string
  metadata: string
}

export const initialBucketFormData: BucketFormData = {
  name: '',
  region: 'Auto',
  protocol: '',
  provisioningMode: 'static', // NEW: Default to static
  volumeType: '',
  volumeEndpoint: '',
  mountOptions: [],
  storageClassName: undefined, // NEW
  storageSize: undefined, // NEW
  volumeParameters: [], // NEW
  authType: '',
  authUsername: '',
  authPassword: '',
  metadata: '',
}

