import React, { useEffect, useMemo, useRef, useState } from 'react'
import { makeStyles, tokens, Spinner, Text, Badge } from '@fluentui/react-components'
import {
  ChevronDown16Regular,
  ChevronUp16Regular,
  Checkmark16Regular,
  Warning16Regular,
  People16Regular,
} from '@fluentui/react-icons'
import { GenericToolFallback } from './GenericToolFallback'

const SEPARATOR = ' › '

type ToolPart = {
  readonly type: 'tool-call'
  readonly toolCallId: string
  readonly toolName: string
  readonly argsText: string
  readonly args: unknown
  readonly result?: unknown
  readonly status: { type: 'running' | 'complete' | 'incomplete' | 'requires-action'; reason?: string }
}

interface ToolActivityCapsuleProps {
  parts: readonly ToolPart[]
  isStreaming: boolean
}

const useStyles = makeStyles({
  capsule: {
    margin: '6px 0',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '10px',
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  capsuleError: {
    border: `1px solid ${tokens.colorPaletteRedBorder2}`,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
    padding: '8px 12px',
    backgroundColor: tokens.colorNeutralBackground2,
    border: 'none',
    cursor: 'pointer',
    fontSize: '12px',
    color: tokens.colorNeutralForeground2,
    textAlign: 'left',
    fontFamily: 'inherit',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground2Hover,
    },
    ':focus-visible': {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '-2px',
    },
  },
  headerError: {
    backgroundColor: tokens.colorPaletteRedBackground1,
    color: tokens.colorPaletteRedForeground1,
    ':hover': {
      backgroundColor: tokens.colorPaletteRedBackground2,
    },
  },
  statusIcon: {
    display: 'inline-flex',
    flexShrink: 0,
  },
  summary: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 500,
  },
  meta: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    fontWeight: 400,
    flexShrink: 0,
  },
  body: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    maxHeight: 'min(60vh, 520px)',
    overflowY: 'auto',
    overflowAnchor: 'auto',
    padding: '4px 8px',
  },
  band: {
    paddingTop: '4px',
    paddingBottom: '4px',
    '& + &': {
      borderTop: `1px dashed ${tokens.colorNeutralStroke3}`,
      marginTop: '4px',
      paddingTop: '8px',
    },
  },
  bandLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 8px',
    margin: '2px 0 4px 4px',
    fontSize: '10px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    color: tokens.colorNeutralForeground3,
    fontWeight: 600,
  },
})

function parseToolName(toolName: string): { memberName?: string; actualToolName: string } {
  const idx = toolName.indexOf(SEPARATOR)
  if (idx >= 0) {
    return {
      memberName: toolName.slice(0, idx),
      actualToolName: toolName.slice(idx + SEPARATOR.length),
    }
  }
  return { actualToolName: toolName }
}

function humanize(name: string): string {
  return name
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

type Band = {
  memberName?: string
  items: ToolPart[]
}

function computeBands(parts: readonly ToolPart[]): Band[] {
  const bands: Band[] = []
  for (const part of parts) {
    const { memberName } = parseToolName(part.toolName)
    const last = bands[bands.length - 1]
    if (last && last.memberName === memberName) {
      last.items.push(part)
    } else {
      bands.push({ memberName, items: [part] })
    }
  }
  return bands
}

function adaptForFallback(part: ToolPart): React.ComponentProps<typeof GenericToolFallback> {
  return {
    type: 'tool-call',
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    argsText: part.argsText,
    args: part.args as Record<string, unknown>,
    result: part.result,
    status: part.status,
    addResult: () => undefined,
    resume: () => undefined,
  } as unknown as React.ComponentProps<typeof GenericToolFallback>
}

export const ToolActivityCapsule: React.FC<ToolActivityCapsuleProps> = ({ parts, isStreaming }) => {
  const styles = useStyles()

  const [expanded, setExpanded] = useState<boolean>(() => isStreaming)
  const userToggledRef = useRef(false)
  const prevStreamingRef = useRef(isStreaming)

  useEffect(() => {
    const justFinished = prevStreamingRef.current && !isStreaming
    prevStreamingRef.current = isStreaming
    if (justFinished && !userToggledRef.current) {
      setExpanded(false)
    }
  }, [isStreaming])

  const stats = useMemo(() => {
    let complete = 0
    let errors = 0
    let running: ToolPart | undefined
    const members = new Set<string>()
    for (const p of parts) {
      const { memberName } = parseToolName(p.toolName)
      if (memberName) members.add(memberName)
      const t = p.status?.type
      if (t === 'complete') complete += 1
      else if (t === 'incomplete') errors += 1
      else if (t === 'running') running = p
    }
    return { complete, errors, running, memberCount: members.size }
  }, [parts])

  const bands = useMemo(() => computeBands(parts), [parts])

  if (parts.length === 0) return null

  const hasErrors = stats.errors > 0
  const total = parts.length

  let summaryText: string
  if (isStreaming && stats.running) {
    const { actualToolName, memberName } = parseToolName(stats.running.toolName)
    const display = humanize(actualToolName)
    const prefix = memberName ? `${memberName} · ` : ''
    summaryText = `${prefix}${display}`
  } else if (isStreaming) {
    summaryText = 'Working…'
  } else if (hasErrors) {
    summaryText = `${stats.errors} failed, ${stats.complete} succeeded`
  } else {
    summaryText = `${total} step${total === 1 ? '' : 's'}`
  }

  const onToggle = () => {
    userToggledRef.current = true
    setExpanded((e) => !e)
  }

  return (
    <div
      className={`${styles.capsule} ${hasErrors ? styles.capsuleError : ''}`}
      role="region"
      aria-label={`Tool activity, ${total} step${total === 1 ? '' : 's'}`}
    >
      <button
        type="button"
        className={`${styles.header} ${hasErrors ? styles.headerError : ''}`}
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className={styles.statusIcon}>
          {isStreaming ? (
            <Spinner size="extra-tiny" />
          ) : hasErrors ? (
            <Warning16Regular />
          ) : (
            <Checkmark16Regular />
          )}
        </span>
        <span className={styles.summary} aria-live="polite">
          {summaryText}
        </span>
        <span className={styles.meta}>
          {isStreaming && total > 0 && (
            <Text size={100}>
              {stats.complete}/{total}
            </Text>
          )}
          {!isStreaming && stats.memberCount > 1 && (
            <Badge size="small" appearance="tint" color="brand">
              {stats.memberCount} agents
            </Badge>
          )}
          {!isStreaming && !hasErrors && total > 0 && stats.memberCount <= 1 && (
            <Text size={100}>{total}</Text>
          )}
        </span>
        {expanded ? <ChevronUp16Regular /> : <ChevronDown16Regular />}
      </button>

      {expanded && (
        <div className={styles.body}>
          {bands.map((band, i) => (
            <div key={i} className={styles.band}>
              {band.memberName && (
                <div className={styles.bandLabel}>
                  <People16Regular />
                  <span>{band.memberName}</span>
                </div>
              )}
              {band.items.map((part) => (
                <GenericToolFallback key={part.toolCallId} {...adaptForFallback(part)} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

ToolActivityCapsule.displayName = 'ToolActivityCapsule'
