import { useState, useCallback } from 'react'
import { TreeNode, UploadProgress } from '../types/s3'
import { s3Api } from '../services/api'

interface UseS3OperationsProps {
  projectId?: string
  bucketName?: string
  basePath?: string
  treeState: any
  reloadNode: (node: TreeNode) => Promise<void>
  onError: (error: string) => void
  rootNodeId: string
}

export function useS3Operations({
  projectId,
  basePath,
  treeState,
  reloadNode,
  onError,
  rootNodeId,
}: UseS3OperationsProps) {
  const [uploads, setUploads] = useState<Map<string, UploadProgress>>(new Map())

  const deleteDirectoryRecursive = useCallback(async (
    bucketName: string,
    dirPath: string
  ): Promise<void> => {
    if (!projectId) return

    const normalizedPath = dirPath.replace(/\/$/, '')
    const prefix = `${normalizedPath}/`

    const objects = await s3Api.listObjects(bucketName, prefix)

    const files: string[] = []
    const subdirs: string[] = []

    for (const obj of objects) {
      if (obj.key === prefix) {
        continue
      }

      if (obj.isDirectory || obj.key.endsWith('/')) {
        const subdirPath = obj.key.replace(/\/$/, '')
        if (!subdirs.includes(subdirPath)) {
          subdirs.push(subdirPath)
        }
      } else {
        files.push(obj.key)
      }
    }

    for (const subdirPath of subdirs) {
      await deleteDirectoryRecursive(bucketName, subdirPath)
    }

    for (const fileKey of files) {
      try {
        await s3Api.deleteObject(bucketName, fileKey, projectId)
      } catch (err: any) {
        console.warn(`Failed to delete file ${fileKey}:`, err)
        throw err
      }
    }

    const dirMarkerPath = `${normalizedPath}/`
    await s3Api.deleteObject(bucketName, dirMarkerPath, projectId)
  }, [projectId])

  // Build a parent node for reloading after operations.
  // If the parent path matches the basePath, reload root instead.
  const buildParentNode = useCallback((bucket: string, parentPath: string): TreeNode => {
    const normalizedBase = basePath?.replace(/\/$/, '') || ''
    if (!parentPath || parentPath === normalizedBase) {
      return {
        id: rootNodeId,
        label: 'root',
        type: 'directory',
        bucketName: bucket,
        path: normalizedBase,
      }
    }
    const parentNodeId = `bucket:${bucket}:path:${parentPath}`
    return {
      id: parentNodeId,
      label: parentPath.split('/').pop() || '',
      type: 'directory',
      bucketName: bucket,
      path: parentPath,
    }
  }, [basePath, rootNodeId])

  const uploadFiles = useCallback(async (
    files: FileList,
    targetBucket: string,
    targetPath: string = ''
  ) => {
    if (!projectId) {
      onError('Project ID is required')
      return
    }

    const fileArray = Array.from(files)

    for (const file of fileArray) {
      const uploadId = `${targetBucket}/${targetPath ? `${targetPath}/` : ''}${file.name}-${Date.now()}`

      setUploads(prev => {
        const next = new Map(prev)
        next.set(uploadId, { file, progress: 0 })
        return next
      })

      try {
        const objectKey = targetPath ? `${targetPath}/${file.name}` : file.name
        await s3Api.putObject(
          targetBucket,
          objectKey,
          file,
          projectId,
          (uploaded: number, total: number) => {
            const progress = total > 0 ? Math.round((uploaded / total) * 100) : 0
            setUploads(prev => {
              const next = new Map(prev)
              const current = next.get(uploadId)
              if (current) {
                next.set(uploadId, { ...current, progress })
              }
              return next
            })
          }
        )

        setUploads(prev => {
          const next = new Map(prev)
          next.delete(uploadId)
          return next
        })

        // Reload the target node
        const normalizedTargetPath = targetPath ? targetPath.replace(/\/$/, '') : ''
        const normalizedBase = basePath?.replace(/\/$/, '') || ''
        if (!normalizedTargetPath || normalizedTargetPath === normalizedBase) {
          // Upload was to root — reload root
          await reloadNode(buildParentNode(targetBucket, normalizedBase))
        } else {
          const nodeId = `bucket:${targetBucket}:path:${normalizedTargetPath}`
          const nodeState = treeState[nodeId]
          if (nodeState?.expanded) {
            const node: TreeNode = {
              id: nodeId,
              label: normalizedTargetPath.split('/').pop() || '',
              type: 'directory',
              bucketName: targetBucket,
              path: normalizedTargetPath,
            }
            await reloadNode(node)
          }
        }
      } catch (err: any) {
        console.error('Failed to upload file:', err)
        setUploads(prev => {
          const next = new Map(prev)
          const current = next.get(uploadId)
          if (current) {
            next.set(uploadId, { ...current, error: err.message || 'Upload failed' })
          }
          return next
        })
      }
    }
  }, [projectId, basePath, treeState, reloadNode, onError, buildParentNode])

  const deleteObject = useCallback(async (node: TreeNode) => {
    if (!node.bucketName || !node.path || !projectId) {
      onError('Missing required information for deletion')
      return
    }

    if (!confirm(`Are you sure you want to delete "${node.label}"?`)) {
      return
    }

    try {
      if (node.type === 'directory') {
        await deleteDirectoryRecursive(node.bucketName, node.path)
      } else {
        await s3Api.deleteObject(node.bucketName, node.path, projectId)
      }

      // Reload the parent node
      const parentPath = node.path.split('/').slice(0, -1).join('/')
      const parentNode = buildParentNode(node.bucketName, parentPath)
      const parentState = treeState[parentNode.id]
      if (parentNode.id === rootNodeId || parentState?.expanded) {
        await reloadNode(parentNode)
      }
    } catch (err: any) {
      console.error('Failed to delete object:', err)
      onError(err.message || 'Failed to delete object')
    }
  }, [projectId, treeState, reloadNode, deleteDirectoryRecursive, onError, buildParentNode, rootNodeId])

  const createDirectory = useCallback(async (
    bucketName: string,
    path: string,
    dirName: string
  ) => {
    if (!projectId) {
      onError('Project ID is required')
      return
    }

    try {
      const dirPath = path ? `${path}/${dirName}` : dirName
      await s3Api.createDirectory(bucketName, dirPath, projectId)

      // Reload the parent node
      const parentNode = buildParentNode(bucketName, path)
      const parentState = treeState[parentNode.id]
      if (parentNode.id === rootNodeId || parentState?.expanded) {
        await reloadNode(parentNode)
      }
    } catch (err: any) {
      console.error('Failed to create directory:', err)
      onError(err.message || 'Failed to create directory')
    }
  }, [projectId, treeState, reloadNode, onError, buildParentNode, rootNodeId])

  const downloadFile = useCallback(async (node: TreeNode) => {
    if (!node.bucketName || !node.path || !projectId) {
      onError('Missing required information for download')
      return
    }

    try {
      const downloadUrl = await s3Api.getObjectDownloadUrl(
        node.bucketName,
        node.path,
        projectId
      )

      const link = document.createElement('a')
      link.href = downloadUrl
      link.download = node.label
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)

      setTimeout(() => {
        URL.revokeObjectURL(downloadUrl)
      }, 100)
    } catch (err: any) {
      console.error('Failed to download file:', err)
      onError(err.message || 'Failed to download file')
    }
  }, [projectId, onError])

  return {
    uploads,
    uploadFiles,
    deleteObject,
    createDirectory,
    downloadFile,
    dismissUpload: (uploadId: string) => {
      setUploads(prev => {
        const next = new Map(prev)
        next.delete(uploadId)
        return next
      })
    },
  }
}
