import { S3Object, TreeNode } from '../types/s3'

/**
 * Format bytes to human-readable size string
 */
export function formatSize(bytes?: number): string {
  if (!bytes) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * Build tree nodes from S3 objects list
 * Handles directory structure and file organization
 */
export function buildTreeNodesFromObjects(
  objects: S3Object[],
  bucketName: string,
  parentPath: string
): TreeNode[] {
  const nodes: TreeNode[] = []
  const directories = new Map<string, TreeNode>()
  const files: TreeNode[] = []

  // Normalize parentPath - ensure it doesn't end with / unless it's empty
  const normalizedParentPath = parentPath ? parentPath.replace(/\/$/, '') : ''

  for (const obj of objects) {
    const fullKey = obj.key

    // Skip the directory marker itself (e.g., "subdir/")
    if (normalizedParentPath && fullKey === normalizedParentPath + '/') {
      continue
    }

    // Calculate relative key by removing parent path prefix
    let relativeKey = fullKey
    if (normalizedParentPath) {
      // Remove parent path prefix, ensuring we handle the slash correctly
      const expectedPrefix = normalizedParentPath + '/'
      if (fullKey.startsWith(expectedPrefix)) {
        relativeKey = fullKey.substring(expectedPrefix.length)
      } else if (fullKey === normalizedParentPath) {
        // Exact match (shouldn't happen with proper prefix, but handle it)
        continue
      } else {
        // Key doesn't match expected prefix - skip it (shouldn't happen)
        console.warn(`[S3Explorer] Key "${fullKey}" doesn't match expected prefix "${expectedPrefix}"`)
        continue
      }
    }

    if (obj.isDirectory || relativeKey.endsWith('/')) {
      // Directory - remove trailing slash and get the immediate directory name
      const cleanKey = relativeKey.replace(/\/$/, '')
      const parts = cleanKey.split('/')
      const dirName = parts[0] // First part is the immediate child directory

      if (dirName) {
        const dirPath = normalizedParentPath ? `${normalizedParentPath}/${dirName}` : dirName
        const nodeId = `bucket:${bucketName}:path:${dirPath}`

        if (!directories.has(nodeId)) {
          directories.set(nodeId, {
            id: nodeId,
            label: dirName,
            type: 'directory',
            bucketName,
            path: dirPath,
            fullPath: dirPath,
          })
        }
      }
    } else {
      // File - check if it's in a subdirectory or at current level
      const parts = relativeKey.split('/')
      if (parts.length > 1) {
        // File is in a subdirectory - create directory node for the immediate parent
        const dirName = parts[0]
        const dirPath = normalizedParentPath ? `${normalizedParentPath}/${dirName}` : dirName
        const nodeId = `bucket:${bucketName}:path:${dirPath}`

        if (!directories.has(nodeId)) {
          directories.set(nodeId, {
            id: nodeId,
            label: dirName,
            type: 'directory',
            bucketName,
            path: dirPath,
            fullPath: dirPath,
          })
        }
      } else {
        // File at current level
        const fileName = parts[0]
        const filePath = normalizedParentPath ? `${normalizedParentPath}/${fileName}` : fileName
        const nodeId = `bucket:${bucketName}:file:${filePath}`
        files.push({
          id: nodeId,
          label: fileName,
          type: 'file',
          bucketName,
          path: filePath,
          fullPath: filePath,
          size: obj.size,
          lastModified: obj.lastModified,
        })
      }
    }
  }

  // Add directories first, then files
  directories.forEach(dir => nodes.push(dir))
  nodes.push(...files)

  // Sort: directories first, then files, both alphabetically
  return nodes.sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1
    if (a.type !== 'directory' && b.type === 'directory') return 1
    return a.label.localeCompare(b.label)
  })
}

