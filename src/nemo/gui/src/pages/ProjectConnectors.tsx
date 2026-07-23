import { useParams } from 'react-router-dom'
import { makeStyles, tokens } from '@fluentui/react-components'
import { ConnectorListing } from '../components/datasource/ConnectorListing'

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  title: {
    fontSize: '24px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
})

export default function NamespaceConnectors() {
  const styles = useStyles()
  const { projectId } = useParams<{ projectId: string }>()

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Connectors</h1>
      <ConnectorListing projectId={projectId!} />
    </div>
  )
}
