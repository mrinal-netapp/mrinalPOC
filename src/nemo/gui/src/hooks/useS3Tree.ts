import { useState, useCallback, useRef, useEffect } from 'react'
import { TreeNode, TreeState } from '../types/s3'
import { s3Api, S3EndpointConnectionError } from '../services/api'
import { buildTreeNodesFromObjects } from '../utils/s3Utils'

interface UseS3TreeProps {
  projectId?: string
  bucketName?: string
  basePath?: string
}

const ROOT_NODE_ID = '__root__'

export function useS3Tree({ projectId, bucketName, basePath }: UseS3TreeProps) {
  const [treeState, setTreeState] = useState<TreeState>({})
  const [rootChildren, setRootChildren] = useState<TreeNode[]>([])
  const [rootLoading, setRootLoading] = useState(false)
  const [rootError, setRootError] = useState<string | undefined>()
  // When the root listing fails because the browser couldn't reach the S3
  // endpoint (typically untrusted self-signed cert), we record the offending
  // origin URL so the page can offer a "Open the S3 endpoint in a new tab" link.
  const [rootCertEndpoint, setRootCertEndpoint] = useState<string | undefined>()
  // `rootLoaded` differentiates "never attempted" from "attempted, got empty result" — required
  // because for an empty bucket loadRoot() returns rootLoading=false / rootError=undefined /
  // rootChildren=[] which is byte-for-byte identical to the initial state, otherwise causing
  // any effect gated on those three to re-fire forever.
  const [rootLoaded, setRootLoaded] = useState(false)
  const treeStateRef = useRef<TreeState>(treeState)
  
  // Keep ref in sync with state
  useEffect(() => {
    treeStateRef.current = treeState
  }, [treeState])

  // Reset rootLoaded when bucket/basePath changes so the new project gets a fresh load.
  useEffect(() => {
    setRootLoaded(false)
    setRootChildren([])
    setRootError(undefined)
    setRootCertEndpoint(undefined)
  }, [bucketName, basePath])

  const loadRoot = useCallback(async () => {
    if (!bucketName || !basePath) return

    setRootLoading(true)
    setRootError(undefined)
    setRootCertEndpoint(undefined)

    try {
      const prefix = basePath.replace(/\/$/, '') + '/'
      const objects = await s3Api.listObjects(bucketName, prefix, '/')
      const children = buildTreeNodesFromObjects(objects, bucketName, basePath.replace(/\/$/, ''))
      setRootChildren(children)

      // Pre-populate treeState for root children that are directories
      const newState: TreeState = {}
      for (const child of children) {
        if (child.type === 'directory' && !treeStateRef.current[child.id]) {
          newState[child.id] = {
            expanded: false,
            loaded: false,
            loading: false,
            children: [],
          }
        }
      }
      if (Object.keys(newState).length > 0) {
        setTreeState(prev => ({ ...prev, ...newState }))
      }
    } catch (err: any) {
      console.error('Failed to load project root:', err)
      if (err instanceof S3EndpointConnectionError) {
        setRootCertEndpoint(err.endpoint)
      }
      setRootError(err.message || 'Failed to load project files')
    } finally {
      setRootLoading(false)
      setRootLoaded(true)
    }
  }, [bucketName, basePath])

  const loadNodeChildren = useCallback(async (node: TreeNode) => {
    const nodeId = node.id

    // Mark as loading
    setTreeState(prev => ({
      ...prev,
      [nodeId]: {
        ...prev[nodeId],
        loading: true,
        error: undefined,
      },
    }))

    try {
      if (node.type === 'directory' && node.bucketName && node.path) {
        const normalizedPath = node.path.replace(/\/$/, '')
        const prefix = `${normalizedPath}/`
        const objects = await s3Api.listObjects(node.bucketName, prefix, '/')
        const children = buildTreeNodesFromObjects(objects, node.bucketName, normalizedPath)

        setTreeState(prev => ({
          ...prev,
          [nodeId]: {
            ...prev[nodeId],
            children,
            loaded: true,
            loading: false,
          },
        }))
      }
    } catch (err: any) {
      console.error('Failed to load node children:', err)
      setTreeState(prev => ({
        ...prev,
        [nodeId]: {
          ...prev[nodeId],
          loading: false,
          error: err.message || 'Failed to load content',
        },
      }))
    }
  }, [projectId])

  const toggleNode = useCallback(async (node: TreeNode) => {
    const nodeId = node.id
    const currentState = treeState[nodeId]
    const isExpanded = currentState?.expanded || false

    if (isExpanded) {
      // Collapse
      setTreeState(prev => ({
        ...prev,
        [nodeId]: {
          ...prev[nodeId],
          expanded: false,
        },
      }))
    } else {
      // Expand
      setTreeState(prev => ({
        ...prev,
        [nodeId]: {
          ...prev[nodeId],
          expanded: true,
        },
      }))

      // Load children if not already loaded
      if (!currentState?.loaded) {
        await loadNodeChildren(node)
      }
    }
  }, [treeState, loadNodeChildren])

  const reloadNode = useCallback(async (node: TreeNode) => {
    // Special case: reload root
    if (node.id === ROOT_NODE_ID) {
      await loadRoot()
      return
    }
    await loadNodeChildren(node)
  }, [loadNodeChildren, loadRoot])

  const expandToPath = useCallback(async (targetBucket: string, targetPath: string) => {
    if (!bucketName || !basePath) return

    // Ensure root is loaded. Use rootLoaded (not rootChildren.length) so empty buckets
    // don't trigger re-loads on every expandToPath call.
    if (!rootLoaded) {
      await loadRoot()
      await new Promise(resolve => setTimeout(resolve, 200))
    }

    // If no path specified, we're done
    if (!targetPath || targetPath.trim() === '') {
      return
    }

    // The targetPath might be a full S3 path or a relative path
    // Strip the basePath prefix if present to get the relative portion
    const normalizedBase = basePath.replace(/\/$/, '')
    let relativePath = targetPath.replace(/^\/+|\/+$/g, '')
    if (relativePath.startsWith(normalizedBase + '/')) {
      relativePath = relativePath.substring(normalizedBase.length + 1)
    } else if (relativePath === normalizedBase) {
      return // Already at root
    }

    if (!relativePath) return

    // Split path into segments and expand each directory
    const pathSegments = relativePath.split('/').filter(segment => segment.length > 0)

    let currentPath = normalizedBase
    for (const segment of pathSegments) {
      currentPath = `${currentPath}/${segment}`
      const dirNodeId = `bucket:${targetBucket}:path:${currentPath}`
      
      // Get latest state from ref
      const dirState = treeStateRef.current[dirNodeId]
      
      if (dirState) {
        if (!dirState.expanded) {
          const dirNode: TreeNode = {
            id: dirNodeId,
            label: segment,
            type: 'directory',
            bucketName: targetBucket,
            path: currentPath,
          }
          await toggleNode(dirNode)
          await new Promise(resolve => setTimeout(resolve, 150))
        }
      } else {
        // Node doesn't exist yet — try to expand it anyway
        const dirNode: TreeNode = {
          id: dirNodeId,
          label: segment,
          type: 'directory',
          bucketName: targetBucket,
          path: currentPath,
        }
        await toggleNode(dirNode)
        await new Promise(resolve => setTimeout(resolve, 150))
      }
    }
  }, [bucketName, basePath, rootLoaded, loadRoot, toggleNode])

  return {
    treeState,
    rootChildren,
    rootLoading,
    rootError,
    rootCertEndpoint,
    rootLoaded,
    toggleNode,
    reloadNode,
    loadNodeChildren,
    loadRoot,
    expandToPath,
    ROOT_NODE_ID,
  }
}
