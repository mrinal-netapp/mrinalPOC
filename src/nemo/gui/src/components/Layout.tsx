import { ReactNode, useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  makeStyles,
  tokens,
  Text,
  Badge,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  Button,
  Avatar,
} from '@fluentui/react-components'
import {
  Folder24Regular,
  Cloud24Regular,
  Settings24Regular,
  Cube24Regular,
  Person24Regular,
  SignOut24Regular,
} from '@fluentui/react-icons'
import { projectApi } from '../services/api'
import { useTabs } from '../contexts/TabContext'
import { useAuth } from '../contexts/AuthContext'
import ProjectSidePanel from './ProjectSidePanel'
import Breadcrumb from './breadcrumb/breadcrumb'

// AgentStudio icon — crystal/prism
const AgentStudioIcon = ({ className }: { className?: string }) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    {/* Crystal/Prism - top facet */}
    <path
      d="M12 3L18 7.5L12 11L6 7.5L12 3Z"
      fill="currentColor"
      fillOpacity="1"
    />
    {/* Crystal/Prism - middle section */}
    <path
      d="M12 11L18 7.5L18 12L12 15.5L6 12L6 7.5L12 11Z"
      fill="currentColor"
      fillOpacity="0.8"
    />
    {/* Crystal/Prism - bottom facet */}
    <path
      d="M12 15.5L18 12L18 16.5L12 21L6 16.5L6 12L12 15.5Z"
      fill="currentColor"
      fillOpacity="0.6"
    />
    {/* Highlight on top facet */}
    <path
      d="M12 3L15 5.25L12 7L9 5.25L12 3Z"
      fill="currentColor"
      fillOpacity="0.4"
    />
    {/* Highlight on middle section */}
    <path
      d="M12 11L15 9.25L15 11.5L12 13.25L9 11.5L9 9.25L12 11Z"
      fill="currentColor"
      fillOpacity="0.3"
    />
  </svg>
)

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  appPanel: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '12px 16px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    flexShrink: 0,
  },
  appPanelIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: tokens.colorBrandForeground1,
    flexShrink: 0,
  },
  appPanelTitle: {
    fontSize: '16px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  appPanelBadge: {
    flexShrink: 0,
  },
  appPanelSpacer: {
    flex: 1,
  },
  appPanelRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    marginLeft: 'auto',
  },
  userProfileButton: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minWidth: 'auto',
  },
  userAvatar: {
    flexShrink: 0,
  },
  userName: {
    fontSize: '14px',
    fontWeight: 500,
    color: tokens.colorNeutralForeground1,
    maxWidth: '150px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  mainContainer: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  sidebar: {
    width: '64px',
    backgroundColor: tokens.colorNeutralBackground2,
    borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '12px 0',
    gap: '8px',
  },
  sidebarIcon: {
    minWidth: '40px',
    width: '40px',
    height: '40px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground3,
    },
  },
  sidebarIconActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
    ':hover': {
      backgroundColor: tokens.colorBrandBackground2,
    },
  },
  sidebarBottom: {
    marginTop: 'auto',
    paddingTop: '8px',
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  contentArea: {
    display: 'flex',
    flex: 1,
    flexDirection: 'column',
    overflow: 'hidden',
  },
  projectSidePanelContainer: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  mainContent: {
    flex: 1,
    padding: '24px',
    overflowY: 'auto',
    backgroundColor: tokens.colorNeutralBackground1,
  },
})

interface LayoutProps {
  children: ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const styles = useStyles()
  const navigate = useNavigate()
  const location = useLocation()
  const { addTab, findTabByPath } = useTabs()
  const { user, logout } = useAuth()
  const [projectNames, setProjectNames] = useState<Map<string, string>>(new Map())

  // Check if we're in a project view
  const projectMatch = location.pathname.match(/^\/projects\/([^/]+)/)
  const projectId = projectMatch ? projectMatch[1] : null
  const isProjectView = projectId !== null
  const isHome = location.pathname === '/'
  const isSettings = location.pathname === '/settings'
  const isDeploymentsList = location.pathname === '/deployments'
  const isDeploymentDetail = location.pathname.match(/^\/deployments\/([^/]+)$/) !== null
  const isPipelinesPage = location.pathname.includes('/pipelines')
  const isFullHeightPage = /\/agents\/.*\/chat$/.test(location.pathname) || /\/agent-teams\/.*\/chat$/.test(location.pathname) || /\/agents\/playground/.test(location.pathname) || /\/lineage$/.test(location.pathname)

  // Fetch project name for banner display
  useEffect(() => {
    if (projectId && !projectNames.has(projectId)) {
      projectApi.get(projectId)
        .then(project => {
          setProjectNames(prev => new Map(prev).set(projectId, project.name))
        })
        .catch(err => {
          console.error('Failed to fetch project name:', err)
          // Use short ID as fallback
          const fallbackName = projectId.length > 12 ? projectId.substring(0, 12) + '...' : projectId
          setProjectNames(prev => new Map(prev).set(projectId, fallbackName))
        })
    }
  }, [projectId, projectNames])

  // Handle tab creation when navigating
  useEffect(() => {
    if (projectId) {
      // Create or activate project tab
      const tabPath = `/projects/${projectId}`
      const existingTab = findTabByPath(tabPath)
      if (!existingTab) {
        // Fetch project name if not already cached
        const cachedName = projectNames.get(projectId)
        if (cachedName) {
          addTab({
            id: `project-${projectId}`,
            label: cachedName,
            icon: <Folder24Regular />,
            type: 'project',
            projectId,
            path: tabPath,
          })
        } else {
          // Fetch project name first, then create tab
          projectApi.get(projectId)
            .then(project => {
              setProjectNames(prev => new Map(prev).set(projectId, project.name))
              addTab({
                id: `project-${projectId}`,
                label: project.name,
                icon: <Cloud24Regular />,
                type: 'project',
                projectId,
                path: tabPath,
              })
            })
            .catch(err => {
              console.error('Failed to fetch project name:', err)
              // Use short ID as fallback
              const fallbackName = projectId.length > 12 ? projectId.substring(0, 12) + '...' : projectId
              setProjectNames(prev => new Map(prev).set(projectId, fallbackName))
              addTab({
                id: `project-${projectId}`,
                label: fallbackName,
                icon: <Cloud24Regular />,
                type: 'project',
                projectId,
                path: tabPath,
              })
            })
        }
      }
    } else if (isDeploymentDetail) {
      const deploymentMatch = location.pathname.match(/^\/deployments\/([^/]+)$/)
      const deploymentId = deploymentMatch ? deploymentMatch[1] : null
      if (deploymentId) {
        const tabPath = `/deployments/${deploymentId}`
        const existingTab = findTabByPath(tabPath)
        if (!existingTab) {
          addTab({
            id: `deployment-${deploymentId}`,
            label: deploymentId,
            icon: <Cube24Regular />,
            type: 'deployment',
            deploymentId,
            path: tabPath,
          })
        }
      }
    }
  }, [location.pathname, projectId, isDeploymentDetail, addTab, findTabByPath, projectNames])

  const handleSidebarClick = (path: string) => {
    navigate(path)
  }

  const isActive = (path: string) => {
    if (path === '/') {
      return isHome
    }
    if (path === '/deployments') {
      return isDeploymentsList || isDeploymentDetail
    }
    if (path === '/settings') {
      return isSettings
    }
    return false
  }

  const handleProfileClick = () => {
    navigate('/settings')
  }

  const handleLogout = async () => {
    try {
      await logout()
    } catch (error) {
      console.error('Logout failed:', error)
    }
  }

  // Get user display name (prefer name, then username, then email, fallback to 'User')
  const getUserDisplayName = () => {
    if (user?.name) return user.name
    if (user?.username) return user.username
    if (user?.email) return user.email
    return 'User'
  }

  return (
    <div className={styles.root}>
      {/* Top-level App Panel */}
      <div className={styles.appPanel}>
        <div className={styles.appPanelIcon}>
          <AgentStudioIcon />
        </div>
        <Text className={styles.appPanelTitle}>AgentStudio</Text>
        <Badge
          appearance="filled"
          color="brand"
          className={styles.appPanelBadge}
        >
          alpha
        </Badge>
        <div className={styles.appPanelSpacer} />
        {user && (
          <div className={styles.appPanelRight}>
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                <Button
                  appearance="subtle"
                  className={styles.userProfileButton}
                  aria-label="User menu"
                >
                  <Avatar
                    className={styles.userAvatar}
                    name={getUserDisplayName()}
                    size={28}
                    color="brand"
                  />
                  <Text className={styles.userName}>{getUserDisplayName()}</Text>
                </Button>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <MenuItem icon={<Person24Regular />} onClick={handleProfileClick}>
                    Profile
                  </MenuItem>
                  <MenuItem icon={<SignOut24Regular />} onClick={handleLogout}>
                    Logout
                  </MenuItem>
                </MenuList>
              </MenuPopover>
            </Menu>
          </div>
        )}
      </div>
      <div className={styles.mainContainer}>
        {/* Left sidebar with icons */}
        <div className={styles.sidebar}>
          <div
            className={`${styles.sidebarIcon} ${isHome ? styles.sidebarIconActive : ''}`}
            onClick={() => handleSidebarClick('/')}
            title="Home"
          >
            <Folder24Regular />
          </div>
          <div
            className={`${styles.sidebarIcon} ${isActive('/deployments') ? styles.sidebarIconActive : ''}`}
            onClick={() => handleSidebarClick('/deployments')}
            title="Deployments"
          >
            <Cube24Regular />
          </div>
          <div className={styles.sidebarBottom}>
            <div
              className={`${styles.sidebarIcon} ${isSettings ? styles.sidebarIconActive : ''}`}
              onClick={() => handleSidebarClick('/settings')}
              title="Settings"
            >
              <Settings24Regular />
            </div>
          </div>
        </div>

        {/* Project side panel (if in project view) */}
        {isProjectView && projectId && (
          <ProjectSidePanel projectId={projectId} />
        )}

        {/* Main content area */}
        <div className={styles.contentArea}>
          {/* Breadcrumb */}
          <Breadcrumb />
          {/* Page content */}
          <div 
            className={styles.mainContent}
            style={(isPipelinesPage || isFullHeightPage) ? { padding: 0, overflow: 'hidden', height: '100%' } : undefined}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
