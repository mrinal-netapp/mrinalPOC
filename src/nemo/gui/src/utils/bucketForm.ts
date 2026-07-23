import { BucketFormData, initialBucketFormData } from '../types/bucket'
import { Bucket, CreateBucketRequest, UpdateBucketRequest, VolumeInfo, AuthInfo } from '../services/api'

/**
 * Infer suggested volume type and protocol from a StorageClass name.
 * Used to auto-populate required volume_config.volume_info.type and volume_config.protocol
 * when creating a dynamic volume (e.g. ontap-nas -> NFS, ontap-san -> NFS/RWO).
 */
export function inferVolumeConfigFromStorageClass(storageClassName: string | undefined): { volumeType: string; protocol: string } {
  if (!storageClassName || !storageClassName.trim()) {
    return { volumeType: 'NFS', protocol: 'NFS' }
  }
  const name = storageClassName.toLowerCase()
  if (name.includes('-nas') || name.includes('nfs')) {
    return { volumeType: 'NFS', protocol: 'NFS' }
  }
  if (name.includes('-san') || name.includes('iscsi') || name.includes('block')) {
    return { volumeType: 'NFS', protocol: 'NFS' }
  }
  if (name.includes('smb') || name.includes('cifs')) {
    return { volumeType: 'SMB', protocol: 'SMB' }
  }
  return { volumeType: 'NFS', protocol: 'NFS' }
}

export function bucketToFormData(bucket: Bucket): BucketFormData {
  // Convert from lowercase (stored in backend) to uppercase (for UI display)
  // Handle both lowercase and uppercase values from backend
  const volumeTypeLower = bucket.volume_info.type.toLowerCase()
  const protocolLower = bucket.protocol.toLowerCase()
  
  // Map to uppercase for UI display (NFS/SMB)
  const volumeType = volumeTypeLower === 'nfs' ? 'NFS' : volumeTypeLower === 'smb' ? 'SMB' : bucket.volume_info.type
  const protocol = protocolLower === 'nfs' ? 'NFS' : protocolLower === 'smb' ? 'SMB' : bucket.protocol
  
  // Ensure protocol matches volumeType
  const finalProtocol = (volumeType === 'NFS' || volumeType === 'SMB') ? volumeType : protocol
  
  // NEW: Determine provisioning mode
  const provisioningMode = bucket.volume_info.provisioning_mode || 'static'
  
  // NEW: Extract volume parameters
  const volumeParameters = bucket.volume_info.parameters
    ? Object.entries(bucket.volume_info.parameters).map(([k, v]) => ({ 
        key: k, 
        value: String(v) 
      }))
    : []
  
  return {
    name: bucket.name,
    region: bucket.region,
    protocol: finalProtocol,
    volumeType: volumeType,
    volumeEndpoint: bucket.volume_info.endpoint || '',
    mountOptions: bucket.volume_info.mount_options || [],
    // NEW fields
    provisioningMode: provisioningMode as 'static' | 'dynamic',
    storageClassName: bucket.volume_info.storage_class_name,
    storageSize: bucket.volume_info.storage_size,
    volumeParameters: volumeParameters,
    // Existing fields
    authType: bucket.auth_info.type,
    authUsername: bucket.auth_info.username || '',
    authPassword: '', // Don't populate password
    metadata: bucket.metadata ? JSON.stringify(bucket.metadata, null, 2) : '',
  }
}

export function formDataToCreateRequest(formData: BucketFormData): CreateBucketRequest {
  let volumeType = formData.volumeType?.trim() || ''
  let protocol = formData.protocol?.trim() || formData.volumeType?.trim() || ''
  if (formData.provisioningMode === 'dynamic' && (!volumeType || !protocol)) {
    const inferred = inferVolumeConfigFromStorageClass(formData.storageClassName)
    if (!volumeType) volumeType = inferred.volumeType
    if (!protocol) protocol = inferred.protocol
  }
  volumeType = volumeType.toLowerCase()
  protocol = (protocol || volumeType).toLowerCase()

  const volumeInfo: VolumeInfo = {
    type: volumeType,
    // Conditional endpoint
    endpoint: formData.provisioningMode === 'static' ? formData.volumeEndpoint : undefined,
    mount_options: formData.mountOptions.length > 0 ? formData.mountOptions : undefined,
    // NEW fields
    provisioning_mode: formData.provisioningMode,
    storage_class_name: formData.provisioningMode === 'dynamic' ? formData.storageClassName : undefined,
    storage_size: formData.provisioningMode === 'dynamic' ? formData.storageSize : undefined,
    parameters: formData.volumeParameters && formData.volumeParameters.length > 0
      ? formData.volumeParameters.reduce((acc, param) => {
          acc[param.key] = param.value
          return acc
        }, {} as Record<string, string>)
      : undefined,
  }

  const authInfo: AuthInfo = {
    type: formData.authType,
    username: formData.authUsername || undefined,
    password_encrypted: formData.authPassword || undefined,
  }

  let metadata: Record<string, any> | undefined
  if (formData.metadata.trim()) {
    try {
      metadata = JSON.parse(formData.metadata)
    } catch (e) {
      throw new Error('Invalid JSON in metadata field')
    }
  }

  return {
    name: formData.name,
    region: formData.region,
    volume_info: volumeInfo,
    auth_info: authInfo,
    protocol: protocol,
    metadata,
  }
}

export function formDataToUpdateRequest(formData: BucketFormData): UpdateBucketRequest {
  let volumeType = formData.volumeType?.trim() || ''
  let protocol = formData.protocol?.trim() || formData.volumeType?.trim() || ''
  if (formData.provisioningMode === 'dynamic' && (!volumeType || !protocol)) {
    const inferred = inferVolumeConfigFromStorageClass(formData.storageClassName)
    if (!volumeType) volumeType = inferred.volumeType
    if (!protocol) protocol = inferred.protocol
  }
  volumeType = volumeType.toLowerCase()
  protocol = (protocol || volumeType).toLowerCase()

  const volumeInfo: Partial<VolumeInfo> = {
    type: volumeType,
    // Conditional endpoint
    endpoint: formData.provisioningMode === 'static' ? formData.volumeEndpoint : undefined,
    mount_options: formData.mountOptions.length > 0 ? formData.mountOptions : undefined,
    // NEW fields
    provisioning_mode: formData.provisioningMode,
    storage_class_name: formData.provisioningMode === 'dynamic' ? formData.storageClassName : undefined,
    storage_size: formData.provisioningMode === 'dynamic' ? formData.storageSize : undefined,
    parameters: formData.volumeParameters && formData.volumeParameters.length > 0
      ? formData.volumeParameters.reduce((acc, param) => {
          acc[param.key] = param.value
          return acc
        }, {} as Record<string, string>)
      : undefined,
  }

  const authInfo: Partial<AuthInfo> = {
    type: formData.authType,
    username: formData.authUsername || undefined,
    password_encrypted: formData.authPassword || undefined,
  }

  let metadata: Record<string, any> | undefined
  if (formData.metadata.trim()) {
    try {
      metadata = JSON.parse(formData.metadata)
    } catch (e) {
      throw new Error('Invalid JSON in metadata field')
    }
  }

  return {
    region: formData.region,
    volume_info: volumeInfo,
    auth_info: authInfo,
    protocol: protocol,
    metadata,
  }
}

export { initialBucketFormData }

