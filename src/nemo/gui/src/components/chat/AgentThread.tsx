import React, { type FC, useCallback, useMemo, useState } from 'react'
import {
  ThreadPrimitive,
  ComposerPrimitive,
  AttachmentPrimitive,
  MessagePrimitive,
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  INTERNAL,
  useAuiState,
  useAttachment,
} from '@assistant-ui/react'
import { StreamdownTextPrimitive } from '@assistant-ui/react-streamdown'
import { code } from '@streamdown/code'
import { mermaid } from '@streamdown/mermaid'
import { makeStyles, tokens, Button, Link, Text } from '@fluentui/react-components'
import {
  Send24Regular,
  Stop24Regular,
  Bot24Regular,
  Person24Regular,
  Copy16Regular,
  ArrowSync16Regular,
  DocumentArrowDown20Regular,
  ChevronDown16Regular,
  ChevronUp16Regular,
  Attach24Regular,
  Dismiss16Regular,
  Document16Regular,
  Timeline20Regular,
} from '@fluentui/react-icons'
import TraceDrawer from './TraceDrawer'
import { SQLResultToolUI } from './SQLResultToolUI'
import { ToolActivityCapsule } from './ToolActivityCapsule'
import FilePreviewModal from '../FilePreviewModal'
import type { StreamDoneMetadata } from '../../hooks/useAgentRuntime'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
  },
  viewport: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px',
  },
  messageRow: {
    display: 'flex',
    marginBottom: '16px',
    width: '100%',
    paddingLeft: '24px',
    paddingRight: '24px',
    boxSizing: 'border-box',
  },
  userRow: {
    justifyContent: 'flex-end',
  },
  assistantRow: {
    justifyContent: 'flex-start',
  },
  message: {
    display: 'flex',
    gap: '12px',
    maxWidth: '90%',
  },
  avatar: {
    width: '32px',
    height: '32px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    alignSelf: 'flex-start',
  },
  userAvatar: {
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
  },
  assistantAvatar: {
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
  },
  userBubble: {
    backgroundColor: tokens.colorBrandBackground2,
    borderRadius: '16px 16px 4px 16px',
    padding: '10px 16px',
    color: tokens.colorNeutralForeground1,
    fontSize: '14px',
    lineHeight: '1.5',
    '& p': {
      margin: 0,
    },
  },
  assistantContent: {
    flex: 1,
    minWidth: 0,
    overflowX: 'auto',
    '& pre': {
      borderRadius: '8px',
      overflow: 'auto',
    },
    '& table': {
      borderCollapse: 'collapse',
      minWidth: '100%',
      width: 'max-content',
      marginTop: '8px',
      marginBottom: '8px',
    },
    '& th, & td': {
      border: `1px solid ${tokens.colorNeutralStroke2}`,
      padding: '6px 10px',
      textAlign: 'left',
      whiteSpace: 'nowrap',
    },
    '& th': {
      backgroundColor: tokens.colorNeutralBackground3,
      fontWeight: 600,
    },
  },
  composerInput: {
    flex: 1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: '8px',
    padding: '10px 14px',
    fontSize: '14px',
    resize: 'none',
    fontFamily: 'inherit',
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    outline: 'none',
    minHeight: '40px',
    maxHeight: '120px',
  },
  actionBar: {
    display: 'flex',
    gap: '4px',
    marginTop: '4px',
  },
  metadata: {
    display: 'flex',
    gap: '12px',
    marginTop: '4px',
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
  },
  citationsContainer: {
    marginTop: '6px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: '6px',
  },
  citationsToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    cursor: 'pointer',
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    background: 'none',
    border: 'none',
    padding: '2px 0',
    ':hover': {
      color: tokens.colorNeutralForeground2,
    },
  },
  citationsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    marginTop: '4px',
  },
  citationItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 8px',
    borderRadius: '6px',
    backgroundColor: tokens.colorNeutralBackground4,
    fontSize: '12px',
  },
  citationIcon: {
    color: tokens.colorBrandForeground1,
    flexShrink: 0,
  },
  citationName: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  citationScore: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
  },
  composerWrapper: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: '8px 24px 12px',
    width: '100%',
    boxSizing: 'border-box',
  },
  attachmentPreview: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '6px',
    marginBottom: '6px',
  },
  attachmentChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '4px 8px',
    borderRadius: '6px',
    backgroundColor: tokens.colorNeutralBackground3,
    fontSize: '12px',
    maxWidth: '200px',
  },
  attachmentName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  composerInputRow: {
    display: 'flex',
    gap: '8px',
    alignItems: 'flex-end',
  },
})

const StreamdownText = INTERNAL.withSmoothContextProvider(() => (
  <StreamdownTextPrimitive plugins={{ code, mermaid }} />
))

const NoopToolPart: FC = () => null

type Citation = NonNullable<StreamDoneMetadata['citations']>[number]

function friendlyFileName(source: string): string {
  const parts = source.split('/')
  return parts[parts.length - 1] || source
}

interface AgentThreadProps {
  runtime: ReturnType<typeof import('../../hooks/useAgentRuntime').useAgentRuntime>
  metadata?: StreamDoneMetadata | null
}

const AgentThread: FC<AgentThreadProps> = ({ runtime, metadata }) => {
  const styles = useStyles()
  const [activeTraceId, setActiveTraceId] = useState<string | null>(null)
  const handleOpenTrace = useCallback((id: string) => {
    setActiveTraceId(id)
  }, [])

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className={styles.root}>
        <ThreadPrimitive.Viewport className={styles.viewport}>
          <ThreadPrimitive.Messages
            components={{
              UserMessage: UserMessage,
              AssistantMessage: () => (
                <AssistantMessage streamMeta={metadata} onOpenTrace={handleOpenTrace} />
              ),
            }}
          />
        </ThreadPrimitive.Viewport>

        <Composer />
        <SQLResultToolUI />
        <TraceDrawer
          open={activeTraceId != null && activeTraceId.length > 0}
          traceId={activeTraceId}
          onClose={() => setActiveTraceId(null)}
        />
      </div>
    </AssistantRuntimeProvider>
  )
}

function UserMessage() {
  const styles = useStyles()
  return (
    <div className={`${styles.messageRow} ${styles.userRow}`}>
      <div className={styles.message}>
        <div className={styles.userBubble}>
          <MessagePrimitive.Content
            components={{ Text: ({ text }) => <p>{text}</p> }}
          />
        </div>
        <div className={`${styles.avatar} ${styles.userAvatar}`}>
          <Person24Regular />
        </div>
      </div>
    </div>
  )
}

function AssistantMessage({
  streamMeta,
  onOpenTrace,
}: {
  streamMeta?: StreamDoneMetadata | null
  onOpenTrace: (traceId: string) => void
}) {
  const styles = useStyles()
  const [showCitations, setShowCitations] = useState(false)
  const [previewCitation, setPreviewCitation] = useState<Citation | null>(null)

  const msgCustom = useAuiState(
    (s) => s.message.role === 'assistant'
      ? ((s.message.metadata?.custom ?? {}) as Record<string, unknown>)
      : {} as Record<string, unknown>,
  )
  const isLast = useAuiState((s) => s.message.isLast)
  const messageParts = useAuiState((s) =>
    s.message.role === 'assistant' ? s.message.parts : null,
  )
  const messageStatusType = useAuiState((s) =>
    s.message.role === 'assistant' ? s.message.status?.type : undefined,
  )
  const toolParts = useMemo(() => {
    if (!messageParts) return []
    return messageParts.filter(
      (p): p is typeof p & { type: 'tool-call' } => p.type === 'tool-call',
    )
  }, [messageParts])
  const isStreaming = messageStatusType === 'running'

  const modelName = (msgCustom.modelName as string | undefined) ?? (isLast ? streamMeta?.modelName : undefined)
  const latencyMs = (msgCustom.latencyMs as number | undefined) ?? (isLast ? streamMeta?.latencyMs : undefined)
  const usage = (msgCustom.usage as { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined)
    ?? (isLast ? streamMeta?.usage : undefined)
  const citations = (msgCustom.citations as StreamDoneMetadata['citations'] | undefined) ?? (isLast ? streamMeta?.citations : undefined)
  const traceId =
    (msgCustom.traceId as string | undefined) ?? (isLast ? streamMeta?.traceId : undefined)

  return (
    <div className={`${styles.messageRow} ${styles.assistantRow}`}>
      <div className={styles.message}>
        <div className={`${styles.avatar} ${styles.assistantAvatar}`}>
          <Bot24Regular />
        </div>
        <div className={styles.assistantContent}>
          {toolParts.length > 0 && (
            <ToolActivityCapsule
              parts={toolParts as unknown as React.ComponentProps<typeof ToolActivityCapsule>['parts']}
              isStreaming={isStreaming}
            />
          )}
          <MessagePrimitive.Content
            components={{
              Text: StreamdownText,
              tools: { Fallback: NoopToolPart },
            }}
          />

          <div className={styles.actionBar}>
            <ActionBarPrimitive.Copy asChild>
              <Button size="small" appearance="subtle" icon={<Copy16Regular />}>
                Copy
              </Button>
            </ActionBarPrimitive.Copy>
            {traceId && (
              <Button
                size="small"
                appearance="subtle"
                icon={<Timeline20Regular />}
                title="View execution trace"
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenTrace(traceId)
                }}
              >
                Trace
              </Button>
            )}
            <ActionBarPrimitive.Reload asChild>
              <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />}>
                Retry
              </Button>
            </ActionBarPrimitive.Reload>
          </div>

          {(modelName || latencyMs != null || usage) && (
            <div className={styles.metadata}>
              {modelName && <span>{modelName}</span>}
              {latencyMs != null && (
                <span>{(latencyMs / 1000).toFixed(1)}s</span>
              )}
              {usage?.promptTokens != null && <span>P {usage.promptTokens}</span>}
              {usage?.completionTokens != null && <span>C {usage.completionTokens}</span>}
              {usage?.totalTokens != null && <span>T {usage.totalTokens}</span>}
            </div>
          )}

          {citations && citations.length > 0 && (
            <div className={styles.citationsContainer}>
              <button
                className={styles.citationsToggle}
                onClick={() => setShowCitations(!showCitations)}
              >
                <DocumentArrowDown20Regular />
                <span>{citations.length} source{citations.length !== 1 ? 's' : ''} cited</span>
                {showCitations ? <ChevronUp16Regular /> : <ChevronDown16Regular />}
              </button>
              {showCitations && (
                <div className={styles.citationsList}>
                  {citations.map((c, i) => (
                    <div key={i} className={styles.citationItem}>
                      <DocumentArrowDown20Regular className={styles.citationIcon} />
                      <span className={styles.citationName} title={c.source}>
                        {c.downloadUrl ? (
                          <Link
                            as="button"
                            onClick={(e) => { e.stopPropagation(); setPreviewCitation(c) }}
                          >
                            {friendlyFileName(c.source)}
                          </Link>
                        ) : (
                          friendlyFileName(c.source)
                        )}
                      </span>
                      {c.knowledgeBaseName && (
                        <Text size={100} style={{ color: tokens.colorNeutralForeground3, flexShrink: 0 }}>
                          {c.knowledgeBaseName}
                        </Text>
                      )}
                      {c.score != null && (
                        <span className={styles.citationScore}>
                          {(c.score * 100).toFixed(0)}%
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {previewCitation?.downloadUrl && (
                <FilePreviewModal
                  url={previewCitation.downloadUrl}
                  fileName={friendlyFileName(previewCitation.source)}
                  onClose={() => setPreviewCitation(null)}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function AttachmentChip() {
  const styles = useStyles()
  const attachment = useAttachment()
  const name = (attachment as { name?: string })?.name || 'file'

  return (
    <AttachmentPrimitive.Root className={styles.attachmentChip}>
      <Document16Regular />
      <span className={styles.attachmentName} title={name}>{name}</span>
      <AttachmentPrimitive.Remove asChild>
        <button
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}
          title="Remove"
        >
          <Dismiss16Regular />
        </button>
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  )
}

function Composer() {
  const styles = useStyles()
  return (
    <ComposerPrimitive.Root className={styles.composerWrapper}>
      <ComposerPrimitive.Attachments
        components={{ File: AttachmentChip, Document: AttachmentChip, Attachment: AttachmentChip }}
      />
      <div className={styles.composerInputRow}>
        <ComposerPrimitive.AddAttachment asChild>
          <Button appearance="subtle" icon={<Attach24Regular />} title="Attach file" />
        </ComposerPrimitive.AddAttachment>
        <ComposerPrimitive.Input
          className={styles.composerInput}
          placeholder="Type a message..."
          autoFocus
        />
        <ThreadPrimitive.If running={false}>
          <ComposerPrimitive.Send asChild>
            <Button appearance="primary" icon={<Send24Regular />} />
          </ComposerPrimitive.Send>
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running>
          <ComposerPrimitive.Cancel asChild>
            <Button appearance="subtle" icon={<Stop24Regular />} />
          </ComposerPrimitive.Cancel>
        </ThreadPrimitive.If>
      </div>
    </ComposerPrimitive.Root>
  )
}

export default AgentThread
