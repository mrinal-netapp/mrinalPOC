import { useState, useMemo } from 'react'
import {
  Text,
  Input,
  Button,
  Dropdown,
  Option,
  Switch,
  makeStyles,
  tokens,
} from '@fluentui/react-components'
import { CronExpressionParser } from 'cron-parser'
import type { ScheduleConfig } from '../../services/api'

interface ScheduleBuilderProps {
  value: ScheduleConfig | undefined
  onChange: (config: ScheduleConfig | undefined) => void
}

interface Preset {
  label: string
  cron: string
}

const PRESETS: Preset[] = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily', cron: '0 0 * * *' },
  { label: 'Weekly', cron: '0 0 * * 0' },
  { label: 'Monthly', cron: '0 0 1 * *' },
]

const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Australia/Sydney',
  'Pacific/Auckland',
]

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    padding: '16px',
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  presets: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap',
  },
  row: {
    display: 'flex',
    gap: '12px',
    alignItems: 'flex-start',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    flex: 1,
  },
  nextRuns: {
    padding: '12px',
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
  },
  nextRunItem: {
    fontFamily: 'monospace',
    fontSize: '12px',
    color: tokens.colorNeutralForeground2,
  },
})

export function ScheduleBuilder({ value, onChange }: ScheduleBuilderProps) {
  const styles = useStyles()
  const [customCron, setCustomCron] = useState(value?.cronExpression || '')
  const [cronError, setCronError] = useState<string | null>(null)

  const cronExpression = value?.cronExpression || ''
  const timezone = value?.timezone || 'UTC'
  const enabled = value?.enabled ?? true

  const nextRuns = useMemo(() => {
    if (!cronExpression) return []
    try {
      const interval = CronExpressionParser.parse(cronExpression, {
        tz: timezone,
      })
      const runs: string[] = []
      for (let i = 0; i < 3; i++) {
        const next = interval.next()
        runs.push(next.toDate().toLocaleString('en-US', { timeZone: timezone }))
      }
      return runs
    } catch {
      return []
    }
  }, [cronExpression, timezone])

  const applyPreset = (cron: string) => {
    setCronError(null)
    setCustomCron(cron)
    onChange({
      cronExpression: cron,
      timezone,
      enabled,
      temporalScheduleId: value?.temporalScheduleId,
    })
  }

  const applyCustomCron = (raw: string) => {
    setCustomCron(raw)
    try {
      CronExpressionParser.parse(raw)
      setCronError(null)
      onChange({
        cronExpression: raw,
        timezone,
        enabled,
        temporalScheduleId: value?.temporalScheduleId,
      })
    } catch {
      setCronError('Invalid cron expression')
    }
  }

  const updateTimezone = (tz: string) => {
    onChange({
      cronExpression,
      timezone: tz,
      enabled,
      temporalScheduleId: value?.temporalScheduleId,
    })
  }

  const toggleEnabled = (on: boolean) => {
    if (!on && !cronExpression) {
      onChange(undefined)
      return
    }
    onChange({
      cronExpression,
      timezone,
      enabled: on,
      temporalScheduleId: value?.temporalScheduleId,
    })
  }

  const activePreset = PRESETS.find((p) => p.cron === cronExpression)

  return (
    <div className={styles.container}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text weight="semibold" size={300}>Acquisition Schedule</Text>
        <Switch
          checked={enabled}
          onChange={(_, data) => toggleEnabled(data.checked)}
          label={enabled ? 'Enabled' : 'Disabled'}
        />
      </div>

      {enabled && (
        <>
          <div>
            <Text size={200} style={{ display: 'block', marginBottom: '8px', color: tokens.colorNeutralForeground3 }}>
              Frequency presets
            </Text>
            <div className={styles.presets}>
              {PRESETS.map((p) => (
                <Button
                  key={p.cron}
                  size="small"
                  appearance={activePreset?.cron === p.cron ? 'primary' : 'outline'}
                  onClick={() => applyPreset(p.cron)}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </div>

          <div className={styles.row}>
            <div className={styles.field}>
              <Text size={200} weight="semibold">Cron Expression</Text>
              <Input
                value={customCron}
                onChange={(_, data) => applyCustomCron(data.value)}
                placeholder="0 0 * * *"
                style={{ fontFamily: 'monospace' }}
              />
              {cronError && (
                <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>{cronError}</Text>
              )}
            </div>
            <div className={styles.field}>
              <Text size={200} weight="semibold">Timezone</Text>
              <Dropdown
                value={timezone}
                selectedOptions={[timezone]}
                onOptionSelect={(_, data) => {
                  if (data.optionValue) updateTimezone(data.optionValue)
                }}
              >
                {TIMEZONES.map((tz) => (
                  <Option key={tz} value={tz}>{tz}</Option>
                ))}
              </Dropdown>
            </div>
          </div>

          {nextRuns.length > 0 && (
            <div className={styles.nextRuns}>
              <Text size={200} weight="semibold" block style={{ marginBottom: '6px' }}>
                Next 3 runs
              </Text>
              {nextRuns.map((run, i) => (
                <div key={i} className={styles.nextRunItem}>{run}</div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
