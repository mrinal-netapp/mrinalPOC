import { useChatRuntime, type StreamDoneMetadata, type StreamEvent } from './useChatRuntime'
import { agentInvokeApi } from '../services/api'

export type { StreamDoneMetadata }

const agentSessionApi = {
  getSession: (projectId: string, agentId: string, sessionId: string) =>
    agentInvokeApi.getSession(projectId, agentId, sessionId),
}

export function useAgentRuntime(
  projectId: string,
  agentId: string,
  sessionId: string,
  onStreamDone?: (meta: StreamDoneMetadata) => void,
  onStreamEvent?: (event: StreamEvent) => void,
  modelIdOverride?: string,
) {
  return useChatRuntime({
    streamUrl: `/agents/api/v1/projects/${projectId}/agents/${agentId}/invoke/stream`,
    projectId,
    entityId: agentId,
    sessionId,
    sessionApi: agentSessionApi,
    onStreamDone,
    onStreamEvent,
    modelIdOverride,
  })
}
