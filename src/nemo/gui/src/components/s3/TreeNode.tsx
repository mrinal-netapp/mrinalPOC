import { memo, useRef } from 'react'
import {
  makeStyles,
  tokens,
  Spinner,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  Button,
} from '@fluentui/react-components'
import {
  Folder24Regular,
  Document24Regular,
  ChevronRight16Regular,
  ChevronDown16Regular,
  ArrowUpload24Regular,
  ArrowDownload24Regular,
  Add24Regular,
  Delete24Regular,
  MoreVertical20Regular,
} from '@fluentui/react-icons'
import { TreeNode as TreeNodeType, TreeState } from '../../types/s3'
import { formatSize } from '../../utils/s3Utils'

const useStyles = makeStyles({
  treeNode: {
    display: 'flex',
    alignItems: 'center',
    padding: '4px 8px',
    cursor: 'pointer',
    borderRadius: tokens.borderRadiusSmall,
    '&:hover': {
      backgroundColor: tokens.colorNeutralBackground2,
      '& $actionButton': {
        opacity: 1,
      },
    },
  },
  treeNodeContent: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flex: 1,
    minWidth: 0,
  },
  treeNodeIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    flexShrink: 0,
  },
  treeNodeLabel: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  treeNodeMetadata: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    marginLeft: 'auto',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  treeChildren: {
    marginLeft: '12px',
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingLeft: '4px',
  },
  loadingNode: {
    padding: '4px 8px 4px 32px',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  emptyNode: {
    padding: '4px 8px 4px 32px',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    fontStyle: 'italic',
  },
  actionButton: {
    minWidth: 'auto',
    width: '20px',
    height: '20px',
    padding: '0',
    opacity: 0.3,
    transition: 'opacity 0.2s',
    flexShrink: 0,
    marginLeft: '4px',
  },
})

interface TreeNodeProps {
  node: TreeNodeType
  level: number
  treeState: TreeState
  searchQuery: string
  onToggle: (node: TreeNodeType) => void
  onUpload: (bucketName: string, path: string) => void
  onCreateDirectory: (bucketName: string, path: string) => void
  onDelete: (node: TreeNodeType) => void
  onDownload?: (node: TreeNodeType) => void
  onDragOver?: (e: React.DragEvent) => void
  onDragLeave?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent, bucketName: string, path: string) => void
  matchesSearch: (node: TreeNodeType) => boolean
  onNodeClick?: (node: TreeNodeType) => void
}

function TreeNodeComponent({
  node,
  level,
  treeState,
  searchQuery,
  onToggle,
  onUpload,
  onCreateDirectory,
  onDelete,
  onDownload,
  onDragOver,
  onDragLeave,
  onDrop,
  matchesSearch,
  onNodeClick,
}: TreeNodeProps) {
  const styles = useStyles()
  const nodeState = treeState[node.id]
  const isExpanded = nodeState?.expanded || false
  const isLoading = nodeState?.loading || false
  const hasError = nodeState?.error
  const children = nodeState?.children || []
  const hasChildren = node.type === 'project' || node.type === 'directory'
  const canExpand = hasChildren && (nodeState?.loaded || !nodeState)
  
  const nodeRef = useRef<HTMLDivElement>(null)

  // Filter by search query
  if (!matchesSearch(node) && node.type !== 'project') {
    if (nodeState?.children) {
      const hasMatchingChild = nodeState.children.some(child => matchesSearch(child))
      if (!hasMatchingChild) return null
    } else {
      return null
    }
  }

  const getIcon = () => {
    if (node.type === 'file') {
      return <Document24Regular />
    }
    if (node.type === 'directory' || node.type === 'project') {
      return <Folder24Regular />
    }
    return null
  }

  const getExpandIcon = () => {
    if (!canExpand) return <div style={{ width: '20px' }} />
    if (isLoading) {
      return <Spinner size="tiny" style={{ width: '16px', height: '16px' }} />
    }
    return isExpanded ? <ChevronDown16Regular /> : <ChevronRight16Regular />
  }

  const handleNodeAction = (action: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (action === 'upload' && node.bucketName) {
      onUpload(node.bucketName, node.path || '')
    } else if (action === 'create-dir' && node.bucketName) {
      onCreateDirectory(node.bucketName, node.path || '')
    } else if (action === 'delete' && (node.type === 'file' || node.type === 'directory')) {
      onDelete(node)
    } else if (action === 'download' && node.type === 'file' && onDownload) {
      onDownload(node)
    }
  }

  const handleNodeClick = () => {
    // Notify parent component about the click for address bar
    if (onNodeClick) {
      onNodeClick(node)
    }
    // For directories, toggle expand/collapse
    if (node.type !== 'file') {
      onToggle(node)
    }
  }

  return (
    <div key={node.id}>
      <div
        ref={nodeRef}
        className={styles.treeNode}
        style={{ paddingLeft: `${level * 12 + 8}px` }}
        onDragOver={node.bucketName && onDragOver ? onDragOver : undefined}
        onDragLeave={node.bucketName && onDragLeave ? onDragLeave : undefined}
        onDrop={node.bucketName && onDrop ? (e) => onDrop(e, node.bucketName!, node.path || '') : undefined}
      >
        <div
          onClick={handleNodeClick}
          style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0, cursor: node.type === 'file' ? 'default' : 'pointer' }}
        >
          <div className={styles.treeNodeIcon}>
            {getExpandIcon()}
          </div>
          <div className={styles.treeNodeContent}>
            <div className={styles.treeNodeIcon}>
              {getIcon()}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flex: 1, minWidth: 0, overflow: 'hidden' }}>
              <div className={styles.treeNodeLabel} title={node.label}>
                {node.label}
              </div>
              {(node.type === 'directory' || node.type === 'file') && (
                <Menu>
                  <MenuTrigger disableButtonEnhancement>
                    <Button
                      appearance="subtle"
                      size="small"
                      icon={<MoreVertical20Regular />}
                      className={styles.actionButton}
                      onClick={(e) => e.stopPropagation()}
                      style={{ flexShrink: 0 }}
                    />
                  </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    {node.type === 'directory' && (
                      <>
                        <MenuItem
                          icon={<ArrowUpload24Regular />}
                          onClick={(e) => {
                            handleNodeAction('upload', e)
                          }}
                        >
                          Upload Files
                        </MenuItem>
                        <MenuItem
                          icon={<Add24Regular />}
                          onClick={(e) => {
                            handleNodeAction('create-dir', e)
                          }}
                        >
                          New Folder
                        </MenuItem>
                        <MenuItem
                          icon={<Delete24Regular />}
                          onClick={(e) => {
                            handleNodeAction('delete', e)
                          }}
                        >
                          Delete
                        </MenuItem>
                      </>
                    )}
                    {node.type === 'file' && (
                      <>
                        {onDownload && (
                          <MenuItem
                            icon={<ArrowDownload24Regular />}
                            onClick={(e) => {
                              handleNodeAction('download', e)
                            }}
                          >
                            Download
                          </MenuItem>
                        )}
                        <MenuItem
                          icon={<Delete24Regular />}
                          onClick={(e) => {
                            handleNodeAction('delete', e)
                          }}
                        >
                          Delete
                        </MenuItem>
                      </>
                    )}
                  </MenuList>
                </MenuPopover>
              </Menu>
              )}
            </div>
            {node.type === 'file' && (
              <div className={styles.treeNodeMetadata}>
                {node.size !== undefined && <span>{formatSize(node.size)}</span>}
                {node.lastModified && (
                  <span>{new Date(node.lastModified).toLocaleDateString()}</span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {hasError && (
        <div className={styles.emptyNode} style={{ paddingLeft: `${level * 12 + 24}px` }}>
          Error: {hasError}
        </div>
      )}
      {isExpanded && canExpand && (
        <div className={styles.treeChildren}>
          {isLoading && (
            <div className={styles.loadingNode}>Loading...</div>
          )}
          {!isLoading && children.length === 0 && (
            <div className={styles.emptyNode}>Empty</div>
          )}
          {!isLoading && children.map(child => (
            <TreeNodeComponent
              key={child.id}
              node={child}
              level={level + 1}
              treeState={treeState}
              searchQuery={searchQuery}
              onToggle={onToggle}
              onUpload={onUpload}
              onCreateDirectory={onCreateDirectory}
              onDelete={onDelete}
              onDownload={onDownload}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              matchesSearch={matchesSearch}
              onNodeClick={onNodeClick}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export const TreeNode = memo(TreeNodeComponent)

