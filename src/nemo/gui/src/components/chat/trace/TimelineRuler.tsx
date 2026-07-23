import { makeStyles, tokens, Text } from '@fluentui/react-components'
import { formatAxisTicks } from '../traceRenderUtils'

const useStyles = makeStyles({
  root: {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    paddingBottom: '8px',
    marginBottom: '4px',
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  track: {
    position: 'relative',
    height: '6px',
    backgroundColor: tokens.colorNeutralBackground4,
    borderRadius: '3px',
    marginBottom: '4px',
  },
  labels: {
    display: 'flex',
    justifyContent: 'space-between',
    paddingLeft: '4px',
    paddingRight: '4px',
  },
})

export interface TimelineRulerProps {
  totalMs: number
}

export function TimelineRuler({ totalMs }: TimelineRulerProps) {
  const styles = useStyles()
  const ticks = formatAxisTicks(totalMs, 5)

  return (
    <div className={styles.root}>
      <div className={styles.track} aria-hidden />
      <div className={styles.labels}>
        {ticks.map((t, i) => (
          <Text key={i} size={100} style={{ color: tokens.colorNeutralForeground3 }}>
            {t.label}
          </Text>
        ))}
      </div>
    </div>
  )
}
