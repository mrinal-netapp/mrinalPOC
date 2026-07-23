import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  makeStyles,
  tokens,
  Text,
  Button,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
} from '@fluentui/react-components'
import { projectApi, Project } from '../services/api'
import { getRuntimeConfig } from '../services/runtimeConfig'
import {
  Flow24Regular,
  Board24Regular,
  ArrowSwap24Regular,
  Checkmark24Regular,
  Archive24Regular,
  Cloud24Regular,
  Table24Regular,
  Wrench24Regular,
  Book24Regular,
  CaretDown16Regular,
  CaretRight16Regular,
  Bot24Regular,
  BotSparkle24Regular,
  FolderOpen24Regular,
  Open16Regular,
  PulseSquare24Regular,
  DataUsage24Regular,
  MoneyCalculator24Regular,
  Server24Regular,
  Key24Regular,
  Organization24Regular,
} from '@fluentui/react-icons'
import { BrainIcon } from './icons'

const useStyles = makeStyles({
  sidePanel: {
    width: '250px',
    backgroundColor: tokens.colorNeutralBackground2,
    borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflowY: 'auto',
  },
  header: {
    padding: '16px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  headerTitle: {
    flex: 1,
    fontSize: '16px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  switchButton: {
    minWidth: 'auto',
    padding: '4px',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground2,
    ':hover': {
      color: tokens.colorNeutralForeground1,
      backgroundColor: tokens.colorNeutralBackground3,
    },
  },
  projectMenuItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 12px',
    fontSize: '13px',
    width: '100%',
  },
  group: {
    display: 'flex',
    flexDirection: 'column',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    marginTop: '12px',
    paddingTop: '12px',
    '&:first-of-type': {
      borderTop: 'none',
      marginTop: '0',
      paddingTop: '0',
    },
  },
  groupHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '12px 16px',
    marginBottom: '4px',
    cursor: 'pointer',
    userSelect: 'none',
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: '4px',
    transition: 'background-color 0.15s ease',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground3,
    },
  },
  groupTitle: {
    flex: 1,
    fontSize: '14px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  groupContent: {
    display: 'flex',
    flexDirection: 'column',
    paddingLeft: '16px',
    paddingBottom: '4px',
  },
  menuItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 16px',
    cursor: 'pointer',
    fontSize: '13px',
    color: tokens.colorNeutralForeground1,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground3,
    },
  },
  menuItemActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
    ':hover': {
      backgroundColor: tokens.colorBrandBackground2,
    },
  },
  iconWithOverlay: {
    position: 'relative',
    display: 'inline-flex',
  },
  iconOverlayOrange: {
    position: 'absolute',
    bottom: '-2px',
    right: '-2px',
    fontSize: '10px',
    fontWeight: 600,
    backgroundColor: tokens.colorPaletteDarkOrangeBackground2,
    color: tokens.colorPaletteDarkOrangeForeground2,
    borderRadius: '50%',
    width: '14px',
    height: '14px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: `1px solid ${tokens.colorNeutralBackground1}`,
  },
  iconOverlayGreen: {
    position: 'absolute',
    bottom: '-2px',
    right: '-2px',
    fontSize: '10px',
    fontWeight: 600,
    backgroundColor: tokens.colorPaletteGreenBackground2,
    color: tokens.colorPaletteGreenForeground2,
    borderRadius: '50%',
    width: '14px',
    height: '14px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: `1px solid ${tokens.colorNeutralBackground1}`,
  },
})

interface ProjectSidePanelProps {
  projectId: string
}

export default function ProjectSidePanel({ projectId }: ProjectSidePanelProps) {
  const styles = useStyles()
  const navigate = useNavigate()
  const location = useLocation()

  const [projectName, setProjectName] = useState<string>(projectId)
  const [projectHomeDir, setProjectHomeDir] = useState<string>('')
  const [projects, setProjects] = useState<Project[]>([])
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['AI']))

  const runtimeConfig = useMemo(() => getRuntimeConfig(), [])

  // Update expanded groups when route changes
  useEffect(() => {
    const groups = new Set<string>()

    groups.add('AI')

    if (location.pathname.includes('/dashboard') || location.pathname.includes('/cost') || location.pathname.includes('/infrastructure')) {
      groups.add('Observability')
    }

    setExpandedGroups(groups)
  }, [location.pathname, projectId])

  // Fetch all projects for the dropdown
  const loadProjects = useCallback(async () => {
    try {
      setLoadingProjects(true)
      const data = await projectApi.list()
      setProjects(data)
    } catch (err) {
      console.error('Failed to load projects:', err)
    } finally {
      setLoadingProjects(false)
    }
  }, [])

  // Fetch project name
  const refreshProjectName = useCallback(() => {
    projectApi.get(projectId)
      .then(project => {
        setProjectName(project.name)
        if (project.home_dir) {
          setProjectHomeDir(project.home_dir)
        }
      })
      .catch(err => {
        console.error('Failed to fetch project name:', err)
        // Keep the ID as fallback
      })
  }, [projectId])

  useEffect(() => {
    refreshProjectName()
  }, [refreshProjectName])

  // Listen for project update events
  useEffect(() => {
    const handleProjectUpdate = (event: CustomEvent) => {
      const { projectId: updatedProjectId } = event.detail
      // Refresh if this is the current project
      if (updatedProjectId === projectId) {
        refreshProjectName()
      }
      // Always refresh the dropdown list
      loadProjects()
    }

    window.addEventListener('project-updated', handleProjectUpdate as EventListener)
    return () => {
      window.removeEventListener('project-updated', handleProjectUpdate as EventListener)
    }
  }, [projectId, refreshProjectName, loadProjects])

  const handleProjectSwitch = (targetProjectId: string) => {
    // Get the current path and replace the project ID
    const currentPath = location.pathname
    const newPath = currentPath.replace(`/projects/${projectId}`, `/projects/${targetProjectId}`)
    navigate(newPath)
  }

  const toggleGroup = (groupName: string) => {
    setExpandedGroups((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(groupName)) {
        newSet.delete(groupName)
      } else {
        newSet.add(groupName)
      }
      return newSet
    })
  }

  const isActive = (path: string) => {
    return location.pathname === path
  }

  const isActivePrefix = (path: string) => {
    return location.pathname.startsWith(path)
  }

  const navigateTo = (path: string) => {
    navigate(path)
  }


  const aiExpanded = expandedGroups.has('AI')
  const observabilityExpanded = expandedGroups.has('Observability')

  // Build Project Explorer URL scoped to the project's home directory.
  // Convention: bucket is extracted from home_dir, path is always "projects/<projectId>".
  const getProjectFilesPath = () => {
    if (projectHomeDir) {
      const match = projectHomeDir.match(/^s3:\/\/([^/]+)\//)
      if (match) {
        const bucket = match[1]
        const path = `projects/${projectId}`
        return `/projects/${projectId}/s3?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}`
      }
    }
    // Fallback: just open Project Explorer without a specific path
    return `/projects/${projectId}/s3`
  }

  return (
    <div className={styles.sidePanel}>
      <div className={styles.header}>
        <Text 
          className={styles.headerTitle}
          style={{ cursor: 'pointer' }}
          onClick={() => navigate(`/projects/${projectId}`)}
          title="Go to project dashboard"
        >
          {projectName}
        </Text>
        <Menu onOpenChange={(_, data) => {
          if (data.open && projects.length === 0) {
            loadProjects()
          }
        }}>
          <MenuTrigger disableButtonEnhancement>
            <Button
              appearance="subtle"
              icon={<ArrowSwap24Regular />}
              className={styles.switchButton}
              title="Switch project"
              aria-label="Switch project"
            />
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {loadingProjects ? (
                <MenuItem disabled>Loading projects...</MenuItem>
              ) : projects.length === 0 ? (
                <MenuItem disabled>No projects available</MenuItem>
              ) : (
                projects.map((ns) => (
                  <MenuItem
                    key={ns.id}
                    onClick={() => handleProjectSwitch(ns.id)}
                    className={styles.projectMenuItem}
                  >
                    <Cloud24Regular />
                    <span style={{ flex: 1 }}> {ns.name} </span>
                    {ns.id === projectId && (
                      <Checkmark24Regular style={{ fontSize: '16px', color: tokens.colorBrandForeground1 }} />
                    )}
                  </MenuItem>
                ))
              )}
            </MenuList>
          </MenuPopover>
        </Menu>
      </div>

      {/* Top-level items */}
      <div className={styles.group}>
        <div
          className={`${styles.menuItem} ${isActivePrefix(`/projects/${projectId}/datasources`) ? styles.menuItemActive : ''}`}
          onClick={() => navigateTo(`/projects/${projectId}/datasources`)}
        >
          <Archive24Regular />
          <span>Data Sources</span>
        </div>
        <div
          className={`${styles.menuItem} ${isActive(`/projects/${projectId}/datasets`) ? styles.menuItemActive : ''}`}
          onClick={() => navigateTo(`/projects/${projectId}/datasets`)}
        >
          <Table24Regular />
          <span>Datasets</span>
        </div>
        <div
          className={`${styles.menuItem} ${isActive(`/projects/${projectId}/pipelines`) ? styles.menuItemActive : ''}`}
          onClick={() => navigateTo(`/projects/${projectId}/pipelines`)}
        >
          <Flow24Regular />
          <span>Pipelines</span>
        </div>
        <div
          className={`${styles.menuItem} ${isActive(`/projects/${projectId}/credentials`) ? styles.menuItemActive : ''}`}
          onClick={() => navigateTo(`/projects/${projectId}/credentials`)}
        >
          <Key24Regular />
          <span>Credentials</span>
        </div>
        <div
          className={`${styles.menuItem} ${isActive(`/projects/${projectId}/lineage`) ? styles.menuItemActive : ''}`}
          onClick={() => navigateTo(`/projects/${projectId}/lineage`)}
        >
          <Organization24Regular />
          <span>Lineage</span>
        </div>
        <div
          className={`${styles.menuItem} ${isActivePrefix(`/projects/${projectId}/s3`) ? styles.menuItemActive : ''}`}
          onClick={() => navigateTo(getProjectFilesPath())}
        >
          <FolderOpen24Regular />
          <span>Project Files</span>
        </div>
      </div>

      {/* AI group — expanded by default */}
      <div className={styles.group}>
        <div
          className={styles.groupHeader}
          onClick={() => toggleGroup('AI')}
        >
          <Bot24Regular />
          <span className={styles.groupTitle}>AI</span>
          {aiExpanded
            ? <CaretDown16Regular style={{ color: tokens.colorNeutralForeground3 }} />
            : <CaretRight16Regular style={{ color: tokens.colorNeutralForeground3 }} />
          }
        </div>
        {aiExpanded && (
          <div className={styles.groupContent}>
            <div
              className={`${styles.menuItem} ${isActive(`/projects/${projectId}/knowledgebases`) ? styles.menuItemActive : ''}`}
              onClick={() => navigateTo(`/projects/${projectId}/knowledgebases`)}
            >
              <Book24Regular />
              <span>Knowledge Bases</span>
            </div>
            <div
              className={`${styles.menuItem} ${isActivePrefix(`/projects/${projectId}/models`) ? styles.menuItemActive : ''}`}
              onClick={() => navigateTo(`/projects/${projectId}/models`)}
            >
              <BrainIcon style={{ width: '24px', height: '24px' }} />
              <span>Models</span>
            </div>
            <div
              className={`${styles.menuItem} ${isActivePrefix(`/projects/${projectId}/mcp-servers`) ? styles.menuItemActive : ''}`}
              onClick={() => navigateTo(`/projects/${projectId}/mcp-servers`)}
            >
              <Wrench24Regular />
              <span>MCP Servers</span>
            </div>
            <div
              className={`${styles.menuItem} ${isActive(`/projects/${projectId}/agents`) ? styles.menuItemActive : ''}`}
              onClick={() => navigateTo(`/projects/${projectId}/agents`)}
            >
              <BotSparkle24Regular />
              <span>Agents</span>
            </div>
          </div>
        )}
      </div>

      {/* Observability group — dashboards, cost, and optional external links */}
      <div className={styles.group}>
        <div
          className={styles.groupHeader}
          onClick={() => toggleGroup('Observability')}
        >
          <PulseSquare24Regular />
          <span className={styles.groupTitle}>Observability</span>
          {observabilityExpanded
            ? <CaretDown16Regular style={{ color: tokens.colorNeutralForeground3 }} />
            : <CaretRight16Regular style={{ color: tokens.colorNeutralForeground3 }} />
          }
        </div>
        {observabilityExpanded && (
          <div className={styles.groupContent}>
            <div
              className={`${styles.menuItem} ${isActive(`/projects/${projectId}/dashboard`) ? styles.menuItemActive : ''}`}
              onClick={() => navigateTo(`/projects/${projectId}/dashboard`)}
            >
              <DataUsage24Regular />
              <span>Dashboard</span>
            </div>
            <div
              className={`${styles.menuItem} ${isActive(`/projects/${projectId}/cost`) ? styles.menuItemActive : ''}`}
              onClick={() => navigateTo(`/projects/${projectId}/cost`)}
            >
              <MoneyCalculator24Regular />
              <span>Cost</span>
            </div>
            <div
              className={`${styles.menuItem} ${isActive(`/projects/${projectId}/infrastructure`) ? styles.menuItemActive : ''}`}
              onClick={() => navigateTo(`/projects/${projectId}/infrastructure`)}
            >
              <Server24Regular />
              <span>Infrastructure</span>
            </div>
            {runtimeConfig.grafanaUrl && (
              <div
                className={styles.menuItem}
                onClick={() => window.open(runtimeConfig.grafanaUrl, '_blank', 'noopener')}
              >
                <Board24Regular />
                <span style={{ flex: 1 }}>Grafana</span>
                <Open16Regular style={{ color: tokens.colorNeutralForeground3 }} />
              </div>
            )}
            {runtimeConfig.jaegerUrl && (
              <div
                className={styles.menuItem}
                onClick={() => window.open(runtimeConfig.jaegerUrl, '_blank', 'noopener')}
              >
                <Board24Regular />
                <span style={{ flex: 1 }}>Traces</span>
                <Open16Regular style={{ color: tokens.colorNeutralForeground3 }} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
