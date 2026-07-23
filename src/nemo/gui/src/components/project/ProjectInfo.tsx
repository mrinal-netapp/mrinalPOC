import { Card, CardHeader, Text, Badge } from '@fluentui/react-components'
import { Project } from '../../services/api'
import styles from '../../styles/projectInfo.module.css'

interface ProjectInfoProps {
  project: Project
  bucketCount: number
}

export function ProjectInfo({ project, bucketCount }: ProjectInfoProps) {
  return (
    <Card className={styles.card}>
      <CardHeader header={<Text weight="semibold">Project Details</Text>} />
      <div className={styles.infoRow}>
        <span className={styles.label}>ID:</span>
        <span className={styles.value}>{project.id}</span>
      </div>
      <div className={styles.infoRow}>
        <span className={styles.label}>Created:</span>
        <span className={styles.value}>
          {project.created_at ? new Date(project.created_at).toLocaleString() : ''}
        </span>
      </div>
      <div className={styles.infoRow}>
        <span className={styles.label}>Updated:</span>
        <span className={styles.value}>
          {project.updated_at ? new Date(project.updated_at).toLocaleString() : ''}
        </span>
      </div>
      <div className={styles.infoRow}>
        <span className={styles.label}>Buckets:</span>
        <Badge appearance="filled" color="brand">
          {bucketCount}
        </Badge>
      </div>
    </Card>
  )
}

