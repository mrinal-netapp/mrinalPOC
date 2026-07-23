import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Button,
  Spinner,
  MessageBar,
  MessageBarBody,
} from '@fluentui/react-components'
import { ScrollableDialogShell } from '../dialog'
import {
  Folder24Regular,
  Document24Regular,
  ChevronRight16Regular,
  ChevronDown16Regular,
  Archive24Regular,
} from '@fluentui/react-icons'
import { datasourceApi, Bucket, DataSourceItem } from '../../services/api'
import { TreeNode, TreeState } from '../../types/s3'
import { useS3Tree } from '../../hooks/useS3Tree'
import { formatSize } from '../../utils/s3Utils'

// Simple custom tree renderer for path selection
function SelectableTree({
  node,
  level,
  treeState,
  buckets,
  onToggle,
  selectedNodeId,
  onSelect,
}: {
  node: TreeNode
  level: number
  treeState: TreeState
  buckets: Bucket[]
  onToggle: (node: TreeNode) => void
  selectedNodeId?: string
  onSelect: (node: TreeNode) => void
}) {
  const nodeState = treeState[node.id]
  const children = nodeState?.children || []
  const isExpanded = nodeState?.expanded || false
  const isLoading = nodeState?.loading || false
  const isSelected = selectedNodeId === node.id
  const hasChildren = node.type === 'bucket' || node.type === 'directory'
  const canExpand = hasChildren && (nodeState?.loaded || !nodeState)

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    // Select the node
    if (node.type === 'directory' || node.type === 'bucket' || node.type === 'file') {
      onSelect(node)
    }
    // Toggle expansion for directories/buckets
    if (hasChildren && canExpand) {
      onToggle(node)
    }
  }

  const getIcon = () => {
    if (node.type === 'file') {
      return <Document24Regular />
    }
    if (node.type === 'bucket') {
      return <Archive24Regular />
    }
    return <Folder24Regular />
  }

  const getExpandIcon = () => {
    if (!canExpand) return <div style={{ width: '16px' }} />
    if (isLoading) {
      return <Spinner size="tiny" style={{ width: '16px', height: '16px' }} />
    }
    return isExpanded ? <ChevronDown16Regular /> : <ChevronRight16Regular />
  }

  const region = node.type === 'bucket' 
    ? buckets.find(b => b.name === node.bucketName)?.region 
    : undefined

  return (
    <div style={{ position: 'relative' }}>
      <div
        onClick={handleClick}
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '6px 8px',
          marginBottom: '2px',
          cursor: 'pointer',
          borderRadius: '4px',
          backgroundColor: isSelected 
            ? 'var(--colorBrandBackground2)' 
            : 'transparent',
          border: isSelected 
            ? '2px solid var(--colorBrandStroke1)' 
            : '2px solid transparent',
          paddingLeft: `${level * 20 + 8}px`,
        }}
        onMouseEnter={(e) => {
          if (!isSelected) {
            e.currentTarget.style.backgroundColor = 'var(--colorNeutralBackground2)'
          }
        }}
        onMouseLeave={(e) => {
          if (!isSelected) {
            e.currentTarget.style.backgroundColor = 'transparent'
          }
        }}
      >
        <div style={{ width: '16px', display: 'flex', alignItems: 'center', marginRight: '8px' }}>
          {getExpandIcon()}
        </div>
        <div style={{ width: '20px', display: 'flex', alignItems: 'center', marginRight: '8px' }}>
          {getIcon()}
        </div>
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.label}
          {region && (
            <span style={{ marginLeft: '8px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
              ({region})
            </span>
          )}
          {node.type === 'file' && node.size !== undefined && (
            <span style={{ marginLeft: '8px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
              {formatSize(node.size)}
            </span>
          )}
        </div>
      </div>
      {isExpanded && canExpand && (
        <div style={{ 
          position: 'relative',
          paddingLeft: '0',
        }}>
          {/* Vertical line connecting to children */}
          <div style={{
            position: 'absolute',
            left: `${level * 20 + 8 + 16}px`,
            top: '0',
            bottom: '0',
            width: '1px',
            backgroundColor: 'var(--colorNeutralStroke2)',
          }} />
          {isLoading && (
            <div style={{ padding: '8px', paddingLeft: `${(level + 1) * 20 + 8 + 4}px`, color: 'var(--colorNeutralForeground3)', fontSize: '12px' }}>
              Loading...
            </div>
          )}
          {!isLoading && children.length === 0 && (
            <div style={{ padding: '8px', paddingLeft: `${(level + 1) * 20 + 8 + 4}px`, color: 'var(--colorNeutralForeground3)', fontSize: '12px', fontStyle: 'italic' }}>
              Empty
            </div>
          )}
          {!isLoading && children.map(child => (
            <SelectableTree
              key={child.id}
              node={child}
              level={level + 1}
              treeState={treeState}
              buckets={buckets}
              onToggle={onToggle}
              selectedNodeId={selectedNodeId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface S3PathSelectorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (bucket: string, path: string) => void
  projectId: string
  initialBucket?: string
  initialPath?: string
}

export function S3PathSelector({
  open,
  onOpenChange,
  onSelect,
  projectId,
  initialBucket,
  initialPath,
}: S3PathSelectorProps) {
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedNode, setSelectedNode] = useState<TreeNode | null>(null)

  const { treeState, toggleNode, expandToPath } = useS3Tree({
    projectId,
  })

  useEffect(() => {
    if (open && projectId) {
      loadBuckets()
    }
  }, [open, projectId])

  useEffect(() => {
    if (open && initialBucket && initialPath) {
      // Expand to initial path when dialog opens
      expandToPath(initialBucket, initialPath)
    }
  }, [open, initialBucket, initialPath, expandToPath])

  const loadBuckets = async () => {
    if (!projectId) return
    
    try {
      setLoading(true)
      setError(null)
      const dataSources = await datasourceApi.list(projectId, { type: 'volume' })
      const mappedBuckets: Bucket[] = dataSources.map((ds: DataSourceItem) => ({
        project_id: ds.project_id,
        name: ds.name,
        region: ds.volume_config?.region || '',
        volume_info: ds.volume_config?.volume_info || { type: '' },
        auth_info: ds.volume_config?.auth_info || { type: '' },
        protocol: ds.volume_config?.protocol || '',
        deployment_config: ds.volume_config?.deployment_config,
        created_at: ds.created_at,
        updated_at: ds.updated_at,
        metadata: ds.metadata,
      }))
      setBuckets(mappedBuckets)
    } catch (err: any) {
      setError(err.message || 'Failed to load buckets')
      console.error('Failed to load buckets:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleNodeClick = useCallback((node: TreeNode) => {
    // Allow selecting directories, buckets, and files
    if (node.type === 'directory' || node.type === 'bucket' || node.type === 'file') {
      setSelectedNode(node)
    }
  }, [])

  const handleConfirm = () => {
    if (selectedNode && selectedNode.bucketName) {
      const path = selectedNode.path || ''
      onSelect(selectedNode.bucketName, path)
      onOpenChange(false)
      setSelectedNode(null)
    }
  }

  const handleCancel = () => {
    onOpenChange(false)
    setSelectedNode(null)
  }

  const rootNodes = useMemo((): TreeNode[] => {
    if (buckets.length === 0) return []
    
    return buckets.map(bucket => ({
      id: `bucket:${bucket.name}`,
      label: bucket.name,
      type: 'bucket' as const,
      bucketName: bucket.name,
    }))
  }, [buckets])

  const selectedPath = selectedNode
    ? `${selectedNode.bucketName}${selectedNode.path ? '/' + selectedNode.path : ''}`
    : ''

  return (
    <ScrollableDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Select S3 Path"
      modalType="modal"
      resizable
      initialWidth="min(900px, 95vw)"
      initialHeight="min(78vh, 760px)"
      minWidth={560}
      minHeight={460}
      body={
        <>
          {error && (
            <MessageBar intent="error" style={{ marginBottom: '16px' }}>
              <MessageBarBody>{error}</MessageBarBody>
            </MessageBar>
          )}

          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
              <Spinner label="Loading buckets..." />
            </div>
          ) : rootNodes.length === 0 ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--colorNeutralForeground3)' }}>
              No buckets available in this project
            </div>
          ) : (
            <>
              <div style={{ margin: '12px 0 12px', fontSize: '14px', color: 'var(--colorNeutralForeground3)' }}>
                Click on a folder or file to select it. All files under the selected path will be included in the dataset.
              </div>
              <div style={{ border: '1px solid var(--colorNeutralStroke2)', borderRadius: '4px', padding: '8px' }}>
                {rootNodes.map(node => (
                  <SelectableTree
                    key={node.id}
                    node={node}
                    level={0}
                    treeState={treeState}
                    buckets={buckets}
                    onToggle={toggleNode}
                    selectedNodeId={selectedNode?.id}
                    onSelect={handleNodeClick}
                  />
                ))}
              </div>
            </>
          )}
        </>
      }
      footer={
        selectedPath ? (
          <div style={{
            padding: '8px 12px',
            backgroundColor: 'var(--colorNeutralBackground2)',
            borderRadius: '4px',
            border: '1px solid var(--colorBrandStroke1)',
          }}>
            <div style={{ fontSize: '12px', color: 'var(--colorNeutralForeground3)', marginBottom: '4px' }}>
              Selected Path:
            </div>
            <div style={{ fontSize: '14px', fontWeight: 500, fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {selectedPath}
            </div>
          </div>
        ) : null
      }
      actions={
        <>
          <Button appearance="secondary" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            appearance="primary"
            onClick={handleConfirm}
            disabled={!selectedNode}
          >
            Select Path
          </Button>
        </>
      }
    />
  )
}

