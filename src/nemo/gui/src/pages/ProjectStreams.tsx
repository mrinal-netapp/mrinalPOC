import {
  makeStyles,
  tokens,
  Card,
  MessageBar,
  MessageBarBody,
} from '@fluentui/react-components'

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

export default function NamespaceStreams() {
  const styles = useStyles()

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Streams</h1>
      <Card>
        <div style={{ padding: '24px' }}>
          <MessageBar intent="info">
            <MessageBarBody>Streams feature coming soon</MessageBarBody>
          </MessageBar>
        </div>
      </Card>
    </div>
  )
}

