import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  makeStyles,
  tokens,
  Button,
  Card,
  CardHeader,
  Text,
  Spinner,
  MessageBar,
  MessageBarBody,
} from '@fluentui/react-components'
import {
  Cloud24Regular,
  Add24Regular,
  ArrowRight24Regular,
} from '@fluentui/react-icons'
import { projectApi, Project } from '../services/api'

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
    maxWidth: '1200px',
    margin: '0 auto',
  },
  header: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  title: {
    fontSize: '32px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
    margin: 0,
  },
  subtitle: {
    fontSize: '16px',
    color: tokens.colorNeutralForeground2,
    margin: 0,
  },
  quickStartSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  sectionTitle: {
    fontSize: '20px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
    margin: 0,
  },
  quickStartGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '16px',
  },
  quickStartCard: {
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    ':hover': {
      transform: 'translateY(-2px)',
      boxShadow: tokens.shadow8,
    },
  },
  recentProjects: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  projectItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground2,
      border: `1px solid ${tokens.colorBrandStroke1}`,
    },
  },
  emptyState: {
    padding: '48px',
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
  },
})

export default function Home() {
  const styles = useStyles()
  const navigate = useNavigate()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadProjects()
  }, [])

  const loadProjects = async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await projectApi.list()
      // Show most recent 5 projects
      setProjects(data.slice(0, 5))
    } catch (err: any) {
      setError(err.message || 'Failed to load projects')
    } finally {
      setLoading(false)
    }
  }

  const handleProjectClick = (projectId: string) => {
    navigate(`/projects/${projectId}`)
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Welcome to AgentStudio</h1>
        <p className={styles.subtitle}>
          Unified Agent and Data platform: manage projects, connect data sources (S3, databases, volumes), build knowledge bases and agents, run pipelines and workflows, and monitor deployments.
        </p>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.quickStartSection}>
        <h2 className={styles.sectionTitle}>Quick Start</h2>
        <div className={styles.quickStartGrid}>
          <Card
            className={styles.quickStartCard}
            onClick={() => navigate('/projects')}
          >
            <CardHeader
              header={
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Cloud24Regular />
                  <Text weight="semibold">View Projects</Text>
                </div>
              }
              description="Browse and manage all your projects"
              action={
                <Button
                  appearance="subtle"
                  icon={<ArrowRight24Regular />}
                  iconPosition="after"
                >
                  Explore
                </Button>
              }
            />
          </Card>

          <Card
            className={styles.quickStartCard}
            onClick={() => navigate('/deployments')}
          >
            <CardHeader
              header={
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Cloud24Regular />
                  <Text weight="semibold">View Deployments</Text>
                </div>
              }
              description="Monitor deployment health and status"
              action={
                <Button
                  appearance="subtle"
                  icon={<ArrowRight24Regular />}
                  iconPosition="after"
                >
                  Explore
                </Button>
              }
            />
          </Card>

          <Card
            className={styles.quickStartCard}
            onClick={() => navigate('/projects')}
          >
            <CardHeader
              header={
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Add24Regular />
                  <Text weight="semibold">Create Project</Text>
                </div>
              }
              description="Create a new project to get started"
              action={
                <Button
                  appearance="subtle"
                  icon={<ArrowRight24Regular />}
                  iconPosition="after"
                >
                  Create
                </Button>
              }
            />
          </Card>
        </div>
      </div>

      <div className={styles.recentProjects}>
        <h2 className={styles.sectionTitle}>Recent Projects</h2>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '24px' }}>
            <Spinner label="Loading projects..." />
          </div>
        ) : projects.length === 0 ? (
          <div className={styles.emptyState}>
            <Cloud24Regular style={{ fontSize: '48px', marginBottom: '16px', opacity: 0.5 }} />
            <p>No projects found. Create your first project to get started.</p>
            <Button
              appearance="primary"
              icon={<Add24Regular />}
              onClick={() => navigate('/projects')}
              style={{ marginTop: '16px' }}
            >
              Create Project
            </Button>
          </div>
        ) : (
          projects.map((p) => (
            <div
              key={p.id}
              className={styles.projectItem}
              onClick={() => handleProjectClick(p.id)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <Cloud24Regular />
                <div>
                  <Text weight="semibold">{p.name}</Text>
                  <div>
                    <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                      {p.id}
                    </Text>
                  </div>
                </div>
              </div>
              <Button
                appearance="subtle"
                icon={<ArrowRight24Regular />}
                onClick={(e) => {
                  e.stopPropagation()
                  handleProjectClick(p.id)
                }}
              >
                Open
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

