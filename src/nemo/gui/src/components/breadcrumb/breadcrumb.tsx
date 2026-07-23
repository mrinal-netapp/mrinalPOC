import { useMemo } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  makeStyles,
} from '@fluentui/react-components'
import { ChevronRight16Regular } from '@fluentui/react-icons'
import { projectApi, knowledgeBaseApi, agentApi, datasetApi, mcpServerApi } from '@/services/api'
import { useState, useEffect } from 'react'

const useStyles = makeStyles({
  breadcrumb: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 16px',
    borderBottom: '1px solid var(--divider)',
    backgroundColor: 'var(--surface-2)',
    flexShrink: 0,
    fontSize: '13px',
  },
  breadcrumbItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    ':hover': {
      color: 'var(--text-primary)',
      textDecoration: 'underline',
    },
  },
  breadcrumbItemActive: {
    color: 'var(--text-primary)',
    cursor: 'default',
    ':hover': {
      textDecoration: 'none',
    },
  },
  separator: {
    color: 'var(--text-tertiary)',
    display: 'flex',
    alignItems: 'center',
  },
})

interface BreadcrumbItem {
  label: string
  path: string
  isActive: boolean
}

/**
 * Shortens a string to max 12 characters by showing first 4 and last 5 chars with dots in between
 * Example: "verylongname" -> "very...name" (12 chars)
 */
function shortenString(str: string, maxLength: number = 12): string {
  if (str.length <= maxLength) {
    return str
  }
  
  const firstPart = str.substring(0, 4)
  const lastPart = str.substring(str.length - 5)
  return `${firstPart}...${lastPart}`
}

export default function Breadcrumb() {
  const styles = useStyles()
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const [projectName, setProjectName] = useState<string | null>(null)
  const [isLoadingProject, setIsLoadingProject] = useState(false)
  const [pipelineName, setPipelineName] = useState<string | null>(null)

  const projectId = params.projectId
  const pipelineId = params.pipelineId
  const kbId = params.kbId
  const agentId = params.agentId
  const datasetId = params.datasetId
  const serverId = params.serverId
  const [kbName, setKbName] = useState<string | null>(null)
  const [agentName, setAgentName] = useState<string | null>(null)
  const [datasetName, setDatasetName] = useState<string | null>(null)
  const [mcpServerName, setMcpServerName] = useState<string | null>(null)

  // Fetch project name
  useEffect(() => {
    if (projectId) {
      setIsLoadingProject(true)
      projectApi.get(projectId)
        .then(project => {
          setProjectName(project.name)
          setIsLoadingProject(false)
        })
        .catch(err => {
          console.error('Failed to fetch project name:', err)
          setProjectName(null)
          setIsLoadingProject(false)
        })
    } else {
      setProjectName(null)
      setIsLoadingProject(false)
    }
  }, [projectId])

  // Fetch pipeline name if editing existing pipeline
  useEffect(() => {
    if (projectId && pipelineId) {
      setPipelineName(pipelineId.substring(0, 8))
    } else {
      setPipelineName(null)
    }
  }, [projectId, pipelineId])

  // Fetch KB name when on a KB detail page
  useEffect(() => {
    if (projectId && kbId) {
      knowledgeBaseApi.get(projectId, kbId)
        .then(kb => setKbName(kb.name))
        .catch(() => setKbName(null))
    } else {
      setKbName(null)
    }
  }, [projectId, kbId])

  // Fetch agent name when on an agent chat page
  useEffect(() => {
    if (projectId && agentId) {
      agentApi.get(projectId, agentId)
        .then(agent => setAgentName(agent.name))
        .catch(() => setAgentName(null))
    } else {
      setAgentName(null)
    }
  }, [projectId, agentId])

  // Fetch dataset name when on a dataset detail page
  useEffect(() => {
    if (projectId && datasetId) {
      datasetApi.get(projectId, datasetId)
        .then(ds => setDatasetName(ds.name))
        .catch(() => setDatasetName(null))
    } else {
      setDatasetName(null)
    }
  }, [projectId, datasetId])

  // Fetch MCP server name when on a server detail page
  useEffect(() => {
    if (projectId && serverId) {
      mcpServerApi.get(projectId, serverId)
        .then(s => setMcpServerName(s.name))
        .catch(() => setMcpServerName(null))
    } else {
      setMcpServerName(null)
    }
  }, [projectId, serverId])

  const breadcrumbs = useMemo<BreadcrumbItem[]>(() => {
    const items: BreadcrumbItem[] = []
    const pathParts = location.pathname.split('/').filter(Boolean)

    // Always start with Home
    items.push({
      label: 'Home',
      path: '/',
      isActive: location.pathname === '/',
    })

    // Handle different route patterns
    if (pathParts[0] === 'projects') {
      items.push({
        label: 'Projects',
        path: '/projects',
        isActive: pathParts.length === 1,
      })

      if (pathParts[1]) {
        // Project level - always use the name if available, show loading if fetching
        const displayName = isLoadingProject 
          ? 'Loading' 
          : projectName || pathParts[1]
        items.push({
          label: shortenString(displayName),
          path: `/projects/${pathParts[1]}`,
          isActive: pathParts.length === 2,
        })

        // Sub-levels
        if (pathParts[2] === 'datasources') {
          items.push({
            label: 'Data Sources',
            path: `/projects/${pathParts[1]}/datasources`,
            isActive: pathParts.length === 3 || pathParts[3] === 'volumes' || pathParts[3] === 'connectors',
          })
          if (pathParts[3] === 'credentials') {
            items.push({
              label: 'Credentials',
              path: `/projects/${pathParts[1]}/datasources/credentials`,
              isActive: true,
            })
          }
        } else if (pathParts[2] === 'credentials') {
          items.push({
            label: 'Credentials',
            path: `/projects/${pathParts[1]}/credentials`,
            isActive: true,
          })
        } else if (pathParts[2] === 'streams') {
          items.push({
            label: 'Streams',
            path: `/projects/${pathParts[1]}/streams`,
            isActive: true,
          })
        } else if (pathParts[2] === 'databases') {
          items.push({
            label: 'Databases',
            path: `/projects/${pathParts[1]}/databases`,
            isActive: true,
          })
        } else if (pathParts[2] === 'datasets') {
          items.push({
            label: 'Datasets',
            path: `/projects/${pathParts[1]}/datasets`,
            isActive: pathParts.length === 3,
          })

          if (pathParts[3]) {
            const dsDisplayName = datasetName || pathParts[3]
            items.push({
              label: shortenString(dsDisplayName),
              path: `/projects/${pathParts[1]}/datasets/${pathParts[3]}`,
              isActive: true,
            })
          }
        } else if (pathParts[2] === 'mcp-servers') {
          items.push({
            label: 'MCP Servers',
            path: `/projects/${pathParts[1]}/mcp-servers`,
            isActive: pathParts.length === 3,
          })

          if (pathParts[3]) {
            const serverDisplayName = mcpServerName || pathParts[3]
            items.push({
              label: shortenString(serverDisplayName),
              path: `/projects/${pathParts[1]}/mcp-servers/${pathParts[3]}`,
              isActive: true,
            })
          }
        } else if (pathParts[2] === 'models') {
          items.push({
            label: 'Models',
            path: `/projects/${pathParts[1]}/models`,
            isActive: pathParts.length === 3,
          })

          if (pathParts[3] === 'provider' && pathParts[4]) {
            items.push({
              label: decodeURIComponent(pathParts[4]),
              path: `/projects/${pathParts[1]}/models/provider/${pathParts[4]}`,
              isActive: true,
            })
          }
        } else if (pathParts[2] === 'agents') {
          items.push({
            label: 'Agents',
            path: `/projects/${pathParts[1]}/agents`,
            isActive: pathParts.length === 3,
          })

          if (pathParts[3] === 'playground') {
            items.push({
              label: 'Playground',
              path: `/projects/${pathParts[1]}/agents/playground`,
              isActive: true,
            })
          } else if (pathParts[3] && pathParts[4] === 'chat') {
            const agentDisplayName = agentName || pathParts[3]
            items.push({
              label: shortenString(agentDisplayName),
              path: `/projects/${pathParts[1]}/agents/${pathParts[3]}/chat`,
              isActive: false,
            })
            items.push({
              label: 'Chat',
              path: `/projects/${pathParts[1]}/agents/${pathParts[3]}/chat`,
              isActive: true,
            })
          }
        } else if (pathParts[2] === 'knowledgebases') {
          items.push({
            label: shortenString('Knowledge Bases'),
            path: `/projects/${pathParts[1]}/knowledgebases`,
            isActive: pathParts.length === 3,
          })

          if (pathParts[3]) {
            const kbDisplayName = kbName || pathParts[3]
            items.push({
              label: shortenString(kbDisplayName),
              path: `/projects/${pathParts[1]}/knowledgebases/${pathParts[3]}`,
              isActive: true,
            })
          }
        } else if (pathParts[2] === 'workflows') {
          items.push({
            label: 'Workflows',
            path: `/projects/${pathParts[1]}/workflows`,
            isActive: pathParts.length === 3,
          })

          if (pathParts[3]) {
            items.push({
              label: shortenString(pathParts[3]),
              path: `/projects/${pathParts[1]}/workflows/${pathParts[3]}`,
              isActive: true,
            })
          }
        } else if (pathParts[2] === 'pipelines') {
          items.push({
            label: 'Pipelines',
            path: `/projects/${pathParts[1]}/pipelines`,
            isActive: pathParts.length === 3 && pathParts[3] !== 'data' && pathParts[3] !== 'api',
          })

          if (pathParts[3] === 'executions') {
            items.push({
              label: 'Executions',
              path: `/projects/${pathParts[1]}/pipelines/executions`,
              isActive: true,
            })
          } else if (pathParts[3] === 'data' || pathParts[3] === 'api') {
            items.push({
              label: pathParts[3] === 'data' ? 'Data' : 'API',
              path: `/projects/${pathParts[1]}/pipelines?type=${pathParts[3] === 'data' ? 'Data' : 'API'}`,
              isActive: pathParts.length === 4,
            })
          }
          if (pathParts[3] && pathParts[4] === 'editor') {
            const typeLabel = pathParts[3] === 'data' ? 'Data' : pathParts[3] === 'api' ? 'API' : pathParts[3]
            items.push({
              label: shortenString(`${typeLabel} Pipeline`),
              path: `/projects/${pathParts[1]}/pipelines`,
              isActive: false,
            })
            items.push({
              label: 'Editor',
              path: pathParts[5] ? `/projects/${pathParts[1]}/pipelines/${pathParts[3]}/editor` : location.pathname,
              isActive: !pathParts[5],
            })
            if (pathParts[5]) {
              const pipelineDisplayName = pipelineName || pathParts[5]
              items.push({
                label: shortenString(pipelineDisplayName),
                path: location.pathname,
                isActive: true,
              })
            }
          }
        } else if (pathParts[2] === 'rays') {
          items.push({
            label: 'Rays',
            path: `/projects/${pathParts[1]}/rays`,
            isActive: true,
          })
        } else if (pathParts[2] === 's3') {
          items.push({
            label: shortenString('Project Explorer'),
            path: `/projects/${pathParts[1]}/s3`,
            isActive: true,
          })
        } else if (pathParts[2] === 'dashboard') {
          items.push({
            label: 'Dashboard',
            path: `/projects/${pathParts[1]}/dashboard`,
            isActive: true,
          })
        } else if (pathParts[2] === 'cost') {
          items.push({
            label: 'Cost',
            path: `/projects/${pathParts[1]}/cost`,
            isActive: true,
          })
        } else if (pathParts[2] === 'infrastructure') {
          items.push({
            label: 'Infrastructure',
            path: `/projects/${pathParts[1]}/infrastructure`,
            isActive: true,
          })
        } else if (pathParts[2] === 'lineage') {
          items.push({
            label: 'Lineage',
            path: `/projects/${pathParts[1]}/lineage`,
            isActive: true,
          })
        }
      }
    } else if (pathParts[0] === 'deployments') {
      items.push({
        label: 'Deployments',
        path: '/deployments',
        isActive: pathParts.length === 1,
      })

      if (pathParts[1]) {
        items.push({
          label: shortenString(pathParts[1]),
          path: `/deployments/${pathParts[1]}`,
          isActive: true,
        })
      }
    } else if (pathParts[0] === 'settings') {
      items.push({
        label: 'Settings',
        path: '/settings',
        isActive: true,
      })
    }

    return items
  }, [location.pathname, projectName, pipelineName, kbName, agentName, datasetName, mcpServerName, isLoadingProject])

  const handleBreadcrumbClick = (path: string, isActive: boolean) => {
    if (!isActive) {
      navigate(path)
    }
  }

  if (breadcrumbs.length <= 1) {
    return null
  }

  return (
    <div className={styles.breadcrumb}>
      {breadcrumbs.map((item, index) => (
        <div key={index} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            className={`${styles.breadcrumbItem} ${item.isActive ? styles.breadcrumbItemActive : ''}`}
            onClick={() => handleBreadcrumbClick(item.path, item.isActive)}
          >
            {item.label}
          </span>
          {index < breadcrumbs.length - 1 && (
            <span className={styles.separator}>
              <ChevronRight16Regular />
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

