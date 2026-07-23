export interface S3Object {
  key: string
  size?: number
  lastModified?: string
  isDirectory?: boolean
}

export interface TreeNode {
  id: string
  label: string
  type: 'project' | 'bucket' | 'directory' | 'file'
  bucketName?: string
  path?: string
  fullPath?: string
  size?: number
  lastModified?: string
  children?: TreeNode[]
  expanded?: boolean
  loaded?: boolean
  loading?: boolean
  error?: string
}

export interface TreeState {
  [nodeId: string]: {
    expanded: boolean
    loaded: boolean
    loading: boolean
    children: TreeNode[]
    error?: string
  }
}

export interface UploadProgress {
  file: File
  progress: number
  error?: string
}

