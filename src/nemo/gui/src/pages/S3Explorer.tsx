import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import {
  makeStyles,
  Spinner,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Card,
  CardHeader,
  Text,
  Button,
  Input,
  Link,
  tokens,
} from '@fluentui/react-components'
import { Dismiss24Regular, Copy24Regular, ArrowUpload24Regular, Add24Regular, ArrowSync24Regular, Open24Regular } from '@fluentui/react-icons'
import { useToast } from '../contexts/ToastContext'
import { projectApi } from '../services/api'
import { TreeNode } from '../types/s3'
import { SearchBar } from '../components/s3/SearchBar'
import { UploadProgress } from '../components/s3/UploadProgress'
import { CreateDirectoryDialog } from '../components/s3/CreateDirectoryDialog'
import { TreeNode as TreeNodeComponent } from '../components/s3/TreeNode'
import { useS3Tree } from '../hooks/useS3Tree'
import { useS3Operations } from '../hooks/useS3Operations'

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
  },
  title: {
    fontSize: '24px',
    fontWeight: 600,
  },
  card: {
    padding: '16px',
  },
  addressBarContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 12px',
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  addressBarRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  addressBarInput: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: tokens.fontSizeBase300,
  },
  copyButton: {
    minWidth: 'auto',
    padding: '4px 8px',
  },
  treeContainer: {
    padding: '8px 0',
    maxHeight: '70vh',
    overflowY: 'auto',
  },
  emptyNode: {
    padding: '4px 8px 4px 32px',
    color: '#666',
    fontSize: '14px',
    fontStyle: 'italic',
  },
  rootActions: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
  },
})

export default function S3Explorer() {
  const styles = useStyles()
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { showToast } = useToast()
  
  const [project, setProject] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [createDirDialogOpen, setCreateDirDialogOpen] = useState(false)
  const [targetPath, setTargetPath] = useState<{ bucket: string; path: string } | null>(null)
  const [selectedNode, setSelectedNode] = useState<TreeNode | null>(null)
  const [addressBarValue, setAddressBarValue] = useState('/')
  const [isEditingAddressBar, setIsEditingAddressBar] = useState(false)

  // Derive bucket and basePath from project data or query params
  const bucketName = useMemo(() => {
    // Try query param first, then derive from project home_dir
    const bucketParam = searchParams.get('bucket')
    if (bucketParam) return bucketParam
    if (project?.home_dir) {
      const match = project.home_dir.match(/^s3:\/\/([^/]+)\//)
      if (match) return match[1]
    }
    return undefined
  }, [searchParams, project])

  const basePath = useMemo(() => {
    if (!projectId) return undefined
    return `projects/${projectId}`
  }, [projectId])

  const {
    treeState,
    rootChildren,
    rootLoading,
    rootError,
    rootCertEndpoint,
    rootLoaded,
    toggleNode,
    reloadNode,
    loadRoot,
    expandToPath,
    ROOT_NODE_ID,
  } = useS3Tree({
    projectId,
    bucketName,
    basePath,
  })

  const {
    uploads,
    uploadFiles,
    deleteObject,
    createDirectory,
    downloadFile,
    dismissUpload,
  } = useS3Operations({
    projectId,
    bucketName,
    basePath,
    treeState,
    reloadNode,
    onError: setError,
    rootNodeId: ROOT_NODE_ID,
  })

  // Load project data
  useEffect(() => {
    if (projectId) {
      loadProjectData()
    }
  }, [projectId])

  // Load root tree when bucket and basePath are ready.
  // Guard on rootLoaded (not rootChildren.length) so empty buckets don't trigger an
  // infinite loop: for an empty bucket, loadRoot() leaves rootChildren=[] which would
  // otherwise satisfy the "not loaded yet" condition and re-fire forever.
  useEffect(() => {
    if (bucketName && basePath && !rootLoading && !rootLoaded && !rootError) {
      loadRoot()
    }
  }, [bucketName, basePath, rootLoading, rootLoaded, rootError, loadRoot])

  // Handle expanding to a specific path from query params
  useEffect(() => {
    const pathParam = searchParams.get('path')

    if (bucketName && pathParam && rootLoaded && !rootLoading) {
      const timer = setTimeout(async () => {
        try {
          await expandToPath(bucketName, pathParam)
        } catch (err) {
          console.error('Failed to expand to path:', err)
        }
      }, 300)

      return () => clearTimeout(timer)
    }
  }, [searchParams, bucketName, rootLoaded, rootLoading, expandToPath])

  const loadProjectData = async () => {
    if (!projectId) return

    try {
      setLoading(true)
      setError(null)
      const projectData = await projectApi.get(projectId)
      setProject(projectData)
    } catch (err: any) {
      setError(err.message || 'Failed to load project data')
    } finally {
      setLoading(false)
    }
  }

  // Convert a tree node path to a project-relative display path
  const toRelativePath = useCallback((node: TreeNode | null): string => {
    if (!node || !basePath) return '/'
    
    const normalizedBase = basePath.replace(/\/$/, '')
    const nodePath = node.path || node.fullPath || ''
    
    if (!nodePath) return '/'
    
    // Strip basePath prefix to get relative path
    if (nodePath.startsWith(normalizedBase + '/')) {
      const relative = nodePath.substring(normalizedBase.length)
      const suffix = node.type === 'directory' ? '/' : ''
      return relative + suffix
    }
    
    if (nodePath === normalizedBase) return '/'
    
    // Path doesn't start with basePath — show as-is with leading /
    return '/' + nodePath + (node.type === 'directory' ? '/' : '')
  }, [basePath])

  const handleUpload = useCallback((bucket: string, path: string) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = (ev) => {
      const target = ev.target as HTMLInputElement
      if (target.files) {
        uploadFiles(target.files, bucket, path)
      }
    }
    input.click()
  }, [uploadFiles])

  const handleRootUpload = useCallback(() => {
    if (!bucketName || !basePath) return
    handleUpload(bucketName, basePath.replace(/\/$/, ''))
  }, [bucketName, basePath, handleUpload])

  const handleRootCreateDirectory = useCallback(() => {
    if (!bucketName || !basePath) return
    setTargetPath({ bucket: bucketName, path: basePath.replace(/\/$/, '') })
    setCreateDirDialogOpen(true)
  }, [bucketName, basePath])

  const handleCreateDirectory = useCallback((bucket: string, path: string) => {
    setTargetPath({ bucket, path })
    setCreateDirDialogOpen(true)
  }, [])

  const handleConfirmCreateDirectory = useCallback(async (dirName: string) => {
    if (!targetPath) {
      setError('Target path is required')
      return
    }

    await createDirectory(targetPath.bucket, targetPath.path, dirName)
    setTargetPath(null)
  }, [targetPath, createDirectory])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent, targetBucket: string, dropPath: string = '') => {
    e.preventDefault()
    e.stopPropagation()

    const files = e.dataTransfer.files
    if (files.length > 0) {
      await uploadFiles(files, targetBucket, dropPath)
    }
  }, [uploadFiles])

  const matchesSearch = useCallback((node: TreeNode): boolean => {
    if (!searchQuery) return true
    const query = searchQuery.toLowerCase()
    return node.label.toLowerCase().includes(query)
  }, [searchQuery])

  const handleNodeClick = useCallback((node: TreeNode) => {
    setSelectedNode(node)
    setAddressBarValue(toRelativePath(node))
    setIsEditingAddressBar(false)
  }, [toRelativePath])

  // Parse a project-relative path from the address bar and navigate to it
  const handleAddressBarSubmit = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!addressBarValue.trim() || !bucketName || !basePath) return
    
    // Clean the path — remove leading slash, trailing slash
    let relativePath = addressBarValue.trim().replace(/^\/+/, '').replace(/\/+$/, '')
    
    // Build the full S3 path
    const normalizedBase = basePath.replace(/\/$/, '')
    const fullPath = relativePath ? `${normalizedBase}/${relativePath}` : normalizedBase
    
    try {
      setError(null)
      await expandToPath(bucketName, fullPath)
      setIsEditingAddressBar(false)
    } catch (err: any) {
      console.error('Failed to navigate to path:', err)
      setIsEditingAddressBar(false)
    }
  }, [addressBarValue, bucketName, basePath, expandToPath])

  // Update address bar when selected node changes
  useEffect(() => {
    if (!isEditingAddressBar) {
      setAddressBarValue(toRelativePath(selectedNode))
    }
  }, [selectedNode, toRelativePath, isEditingAddressBar])

  const handleCopyPath = useCallback(async () => {
    const path = toRelativePath(selectedNode)
    if (!path) return
    
    try {
      await navigator.clipboard.writeText(path)
      showToast('Path copied to clipboard', 'success')
    } catch (err) {
      showToast('Failed to copy path to clipboard', 'error')
    }
  }, [selectedNode, toRelativePath, showToast])

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
        <Spinner label="Loading..." />
      </div>
    )
  }

  const isTreeLoading = rootLoading
  // Don't show the generic error bar when the dedicated cert-error bar is rendered.
  const displayError = rootCertEndpoint ? null : (error || rootError)

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Project Explorer - {project?.name}</h1>
        <Button
          appearance="subtle"
          icon={<Dismiss24Regular />}
          onClick={() => navigate(`/projects/${projectId}`)}
          title="Close"
        />
      </div>

      {rootCertEndpoint && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Can&apos;t reach the S3 endpoint</MessageBarTitle>
            <p style={{ margin: '4px 0' }}>
              Your browser couldn&apos;t connect to <code>{rootCertEndpoint}</code>.
              This usually means the self-signed TLS certificate for the S3 gateway
              hasn&apos;t been accepted yet.
            </p>
            <ol style={{ margin: '8px 0 8px 20px', padding: 0 }}>
              <li>
                <Link href={rootCertEndpoint} target="_blank" rel="noopener noreferrer">
                  Open the S3 endpoint in a new tab <Open24Regular style={{ verticalAlign: 'middle', width: '14px', height: '14px' }} />
                </Link>
              </li>
              <li>Click <strong>Advanced</strong> &rarr; <strong>Proceed to {new URL(rootCertEndpoint).host}</strong> to trust the certificate.</li>
              <li>Come back here and click <strong>Retry</strong>.</li>
            </ol>
            <div style={{ marginTop: '8px' }}>
              <Button
                appearance="primary"
                size="small"
                icon={<ArrowSync24Regular />}
                onClick={() => loadRoot()}
              >
                Retry
              </Button>
            </div>
          </MessageBarBody>
        </MessageBar>
      )}

      {displayError && (
        <MessageBar intent="error">
          <MessageBarBody>{displayError}</MessageBarBody>
        </MessageBar>
      )}

      <Card className={styles.card}>
        <CardHeader
          header={<Text weight="semibold">Project: {project?.name}</Text>}
          action={
            <div className={styles.rootActions}>
              <Button
                appearance="subtle"
                size="small"
                icon={<ArrowUpload24Regular />}
                onClick={handleRootUpload}
                disabled={!bucketName}
                title="Upload files to project root"
              >
                Upload
              </Button>
              <Button
                appearance="subtle"
                size="small"
                icon={<Add24Regular />}
                onClick={handleRootCreateDirectory}
                disabled={!bucketName}
                title="Create folder in project root"
              >
                New Folder
              </Button>
            </div>
          }
        />
        <div className={styles.addressBarRow}>
          <form 
            className={styles.addressBarContainer}
            onSubmit={handleAddressBarSubmit}
            style={{ flex: 1 }}
          >
            <Input
              className={styles.addressBarInput}
              value={addressBarValue}
              onChange={(_, data) => {
                setAddressBarValue(data.value)
                setIsEditingAddressBar(true)
              }}
              onBlur={() => {
                if (isEditingAddressBar) {
                  handleAddressBarSubmit()
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setAddressBarValue(toRelativePath(selectedNode))
                  setIsEditingAddressBar(false)
                }
              }}
              placeholder="Enter path (e.g., /datasets/my-file.csv)"
              title="Click to edit path or enter a new path"
            />
            <Button
              appearance="subtle"
              icon={<Copy24Regular />}
              className={styles.copyButton}
              onClick={handleCopyPath}
              disabled={!selectedNode}
              title="Copy path to clipboard"
              type="button"
            >
              Copy
            </Button>
          </form>
          <div style={{ width: '300px' }}>
            <SearchBar value={searchQuery} onChange={setSearchQuery} />
          </div>
        </div>
        <UploadProgress uploads={uploads} onDismiss={dismissUpload} />
        <div className={styles.treeContainer}>
          {isTreeLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '24px' }}>
              <Spinner label="Loading project files..." size="small" />
            </div>
          ) : rootChildren.length === 0 ? (
            <div className={styles.emptyNode}>No files in this project</div>
          ) : (
            rootChildren.map(node => (
              <TreeNodeComponent
                key={node.id}
                node={node}
                level={0}
                treeState={treeState}
                searchQuery={searchQuery}
                onToggle={toggleNode}
                onUpload={handleUpload}
                onCreateDirectory={handleCreateDirectory}
                onDelete={deleteObject}
                onDownload={downloadFile}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                matchesSearch={matchesSearch}
                onNodeClick={handleNodeClick}
              />
            ))
          )}
        </div>
      </Card>

      <CreateDirectoryDialog
        open={createDirDialogOpen}
        onOpenChange={setCreateDirDialogOpen}
        onConfirm={handleConfirmCreateDirectory}
        bucket={targetPath?.bucket || ''}
        path={targetPath?.path || ''}
      />
    </div>
  )
}
