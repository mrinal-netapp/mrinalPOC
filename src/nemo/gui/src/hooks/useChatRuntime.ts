import {
  useLocalRuntime,
  INTERNAL,
  SimpleTextAttachmentAdapter,
  type ChatModelAdapter,
  type ChatModelRunResult,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import { useMemo, useRef } from 'react'
import { getAuthToken, TokenUsage } from '../services/api'

interface SSEEvent {
  type: string
  data: string
}

function parseSSEBlock(raw: string): SSEEvent | null {
  let eventType = 'message'
  const dataLines: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event: ')) {
      eventType = line.slice(7).trim()
    } else if (line.startsWith('data: ')) {
      dataLines.push(line.slice(6))
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5))
    }
  }
  if (dataLines.length === 0) return null
  return { type: eventType, data: dataLines.join('\n') }
}

async function* parseSSE(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<SSEEvent> {
  if (!body) return

  const decoder = new TextDecoderStream()
  const reader = (body as ReadableStream<Uint8Array>).pipeThrough(decoder as unknown as TransformStream<Uint8Array, string>).getReader()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value

      const parts = buffer.split(/\r?\n\r?\n/)
      buffer = parts.pop() || ''

      for (const part of parts) {
        const evt = parseSSEBlock(part)
        if (evt) yield evt
      }
    }

    if (buffer.trim()) {
      const evt = parseSSEBlock(buffer)
      if (evt) yield evt
    }
  } finally {
    reader.releaseLock()
  }
}

export interface StreamDoneMetadata {
  sessionId: string
  traceId?: string
  latencyMs?: number
  modelName?: string
  usage?: TokenUsage
  citations?: Array<{
    source: string
    documentId?: string
    downloadUrl?: string
    knowledgeBaseId?: string
    knowledgeBaseName?: string
    score?: number
  }> | null
}

export interface AttachmentPayload {
  filename: string
  mimeType: string
  content: string
}

export const ATTACHMENT_LIMITS = {
  maxCount: 5,
  maxSizeBytes: 5 * 1024 * 1024,
  allowedMimeTypes: [
    'text/plain',
    'text/markdown',
    'text/csv',
    'text/html',
    'application/json',
    'application/xml',
    'text/xml',
    'application/pdf',
  ],
} as const

export interface SessionApi {
  getSession(projectId: string, entityId: string, sessionId: string): Promise<{
    sessionId: string
    messages: Array<{
      role: string
      content: string
      timestamp?: string
      latencyMs?: number
      modelName?: string
      usage?: TokenUsage
      traceId?: string
      citations?: StreamDoneMetadata['citations']
      toolCalls?: Array<{
        toolCallId?: string
        toolName?: string
        args?: unknown
        result?: unknown
        id?: string
        name?: string
        arguments?: string
      }>
    }>
    [key: string]: unknown
  }>
}

export interface StreamEvent {
  type: 'tool_call_start' | 'tool_call_result' | 'member_message' | 'member_text'
  toolCallId?: string
  toolName?: string
  memberName?: string
  memberId?: string
  agentName?: string
  agentId?: string
  args?: unknown
  result?: unknown
  text?: string
  timestamp?: number
}

export interface ChatRuntimeOptions {
  streamUrl: string
  projectId: string
  entityId: string
  sessionId: string
  sessionApi: SessionApi
  onStreamDone?: (meta: StreamDoneMetadata) => void
  onStreamEvent?: (event: StreamEvent) => void
  includeToolCallsInTranscript?: boolean
  modelIdOverride?: string
}

export function useChatRuntime({
  streamUrl,
  projectId,
  entityId,
  sessionId,
  sessionApi,
  onStreamDone,
  onStreamEvent,
  includeToolCallsInTranscript = true,
  modelIdOverride,
}: ChatRuntimeOptions) {
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  const onStreamDoneRef = useRef(onStreamDone)
  onStreamDoneRef.current = onStreamDone
  const onStreamEventRef = useRef(onStreamEvent)
  onStreamEventRef.current = onStreamEvent
  const modelIdOverrideRef = useRef(modelIdOverride)
  modelIdOverrideRef.current = modelIdOverride

  const adapter = useMemo<ChatModelAdapter>(
    () => ({
      async *run({ messages, abortSignal }) {
        const lastUserMessage = messages.filter((m) => m.role === 'user').at(-1)
        const messageText =
          lastUserMessage?.content
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map((p) => p.text)
            .join('\n') || ''

        const attachments: AttachmentPayload[] = []
        if (lastUserMessage) {
          for (const part of lastUserMessage.content) {
            if (part.type === 'file' || (part.type as string) === 'document') {
              const filePart = part as { type: string; name?: string; mimeType?: string; data?: string; text?: string }
              attachments.push({
                filename: filePart.name || 'untitled',
                mimeType: filePart.mimeType || 'text/plain',
                content: filePart.data || filePart.text || '',
              })
            }
          }
        }

        if (attachments.length > ATTACHMENT_LIMITS.maxCount) {
          throw new Error(`Too many attachments (${attachments.length}). Maximum is ${ATTACHMENT_LIMITS.maxCount}.`)
        }
        for (const att of attachments) {
          const size = new Blob([att.content]).size
          if (size > ATTACHMENT_LIMITS.maxSizeBytes) {
            throw new Error(`Attachment "${att.filename}" is too large (${(size / 1024 / 1024).toFixed(1)} MB). Maximum is ${ATTACHMENT_LIMITS.maxSizeBytes / 1024 / 1024} MB.`)
          }
        }

        const token = getAuthToken()
        const bodyPayload: Record<string, unknown> = {
          message: messageText,
          sessionId: sessionIdRef.current,
        }
        if (attachments.length > 0) {
          bodyPayload.attachments = attachments
        }
        if (modelIdOverrideRef.current) {
          bodyPayload.modelId = modelIdOverrideRef.current
        }

        const response = await fetch(streamUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(bodyPayload),
          signal: abortSignal,
        })

        if (!response.ok) {
          const errText = await response.text().catch(() => response.statusText)
          throw new Error(`Invocation failed: ${errText}`)
        }

        let text = ''
        const toolCalls = new Map<string, { toolName: string; argsText: string }>()
        const toolResults = new Map<string, unknown>()

        const buildRunResult = (): ChatModelRunResult => ({
          content: [
            ...(includeToolCallsInTranscript
              ? [...toolCalls.entries()].map(([id, tc]) => ({
                  type: 'tool-call' as const,
                  toolCallId: id,
                  toolName: tc.toolName,
                  argsText: tc.argsText,
                  args: JSON.parse(tc.argsText),
                  ...(toolResults.has(id) ? { result: toolResults.get(id) } : {}),
                }))
              : []),
            ...(text ? [{ type: 'text' as const, text }] : []),
          ],
        })

        const mergeWithOverlap = (current: string, incoming: string): string => {
          if (!incoming) return current
          if (!current) return incoming
          if (incoming === current) return current
          // Provider replayed the full accumulated response.
          if (incoming.length > current.length && incoming.startsWith(current)) return incoming
          // Provider replayed an older prefix.
          if (current.length > incoming.length && current.startsWith(incoming)) return current

          // Merge by largest suffix/prefix overlap to prevent block duplication.
          const maxOverlap = Math.min(current.length, incoming.length)
          for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
            if (current.endsWith(incoming.slice(0, overlap))) {
              return current + incoming.slice(overlap)
            }
          }

          return current + incoming
        }

        const appendTextChunk = (incoming: string) => {
          if (!incoming) return
          text = mergeWithOverlap(text, incoming)
        }

        for await (const event of parseSSE(response.body)) {
          if (event.type === 'message') {
            appendTextChunk(event.data)
          } else if (event.type === 'tool_call_start') {
            try {
              const tc = JSON.parse(event.data)
              const displayName = tc.memberName
                ? `${tc.memberName} › ${tc.toolName}`
                : tc.toolName
              toolCalls.set(tc.toolCallId, {
                toolName: displayName,
                argsText: JSON.stringify(tc.args ?? {}),
              })
              onStreamEventRef.current?.({
                type: 'tool_call_start',
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                memberName: tc.memberName,
                memberId: tc.memberId,
                args: tc.args,
              })
            } catch { /* skip malformed */ }
          } else if (event.type === 'tool_call_result') {
            try {
              const tr = JSON.parse(event.data)
              let result = tr.result
              if (typeof result === 'string') {
                try { result = JSON.parse(result) } catch { /* keep as string */ }
              }
              toolResults.set(tr.toolCallId, result)
              onStreamEventRef.current?.({
                type: 'tool_call_result',
                toolCallId: tr.toolCallId,
                toolName: toolCalls.get(tr.toolCallId)?.toolName || '',
                memberName: tr.memberName,
                memberId: tr.memberId,
                result,
              })
            } catch { /* skip malformed */ }
          } else if (event.type === 'done') {
            try {
              const meta = JSON.parse(event.data) as StreamDoneMetadata
              onStreamDoneRef.current?.(meta)
            } catch { /* skip malformed */ }
            text = text.trim()
            yield buildRunResult()
            continue
          } else if (event.type === 'error') {
            appendTextChunk((text ? '\n\n' : '') + `**Error:** ${event.data}`)
          }

          yield buildRunResult()
        }
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [streamUrl],
  )

  const historyAdapter = useMemo(
    () => ({
      async load() {
        try {
          const data = await sessionApi.getSession(projectId, entityId, sessionId)
          const msgs = data.messages || []
          if (msgs.length === 0) return { messages: [] }

          const completeStatus = INTERNAL.getAutoStatus(false, false, false, false, undefined)
          const converted = msgs.map((m) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const content: any[] = []

            if (
              includeToolCallsInTranscript &&
              m.role === 'assistant' &&
              Array.isArray(m.toolCalls) &&
              m.toolCalls.length > 0
            ) {
              for (const tc of m.toolCalls) {
                const callId = tc.toolCallId || tc.id || ''
                const rawName = tc.toolName || tc.name || ''
                const memberName = (tc as Record<string, unknown>).memberName as string | undefined
                const name = memberName ? `${memberName} › ${rawName}` : rawName
                const args = tc.args ?? (tc.arguments ? JSON.parse(tc.arguments) : {})
                content.push({
                  type: 'tool-call' as const,
                  toolCallId: callId,
                  toolName: name,
                  argsText: JSON.stringify(args),
                  args,
                  result: tc.result,
                })
              }
            }

            if (m.content) {
              content.push({ type: 'text' as const, text: m.content })
            }

            const threadMsg: ThreadMessageLike = {
              role: m.role as 'user' | 'assistant',
              content,
              metadata: m.role === 'assistant' ? {
                custom: {
                  ...(m.latencyMs != null && { latencyMs: m.latencyMs }),
                  ...(m.modelName && { modelName: m.modelName }),
                  ...(m.usage && { usage: m.usage }),
                  ...(m.citations && { citations: m.citations }),
                  ...(m.traceId && { traceId: m.traceId }),
                },
              } : undefined,
            }
            return INTERNAL.fromThreadMessageLike(threadMsg, INTERNAL.generateId(), completeStatus)
          })

          return {
            messages: converted.map((m, idx) => ({
              parentId: idx > 0 ? converted[idx - 1]!.id : null,
              message: m,
            })),
          }
        } catch {
          return { messages: [] }
        }
      },
      async append() {
        // Messages are persisted server-side
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, entityId, sessionId, includeToolCallsInTranscript],
  )

  const attachmentAdapter = useMemo(() => new SimpleTextAttachmentAdapter(), [])

  return useLocalRuntime(adapter, {
    adapters: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      history: historyAdapter as any,
      attachments: attachmentAdapter,
    },
  })
}
