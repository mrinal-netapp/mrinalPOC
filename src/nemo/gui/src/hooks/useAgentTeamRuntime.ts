import { useChatRuntime, type StreamDoneMetadata, type StreamEvent } from './useChatRuntime'
import { agentTeamInvokeApi } from '../services/api'

export type { StreamDoneMetadata, StreamEvent }

const teamSessionApi = {
  getSession: (projectId: string, teamId: string, sessionId: string) =>
    agentTeamInvokeApi.getSession(projectId, teamId, sessionId),
}

export function useAgentTeamRuntime(
  projectId: string,
  teamId: string,
  sessionId: string,
  onStreamDone?: (meta: StreamDoneMetadata) => void,
  onStreamEvent?: (event: StreamEvent) => void,
  modelIdOverride?: string,
) {
  return useChatRuntime({
    streamUrl: `/agents/api/v1/projects/${projectId}/agent-teams/${teamId}/invoke/stream`,
    projectId,
    entityId: teamId,
    sessionId,
    sessionApi: teamSessionApi,
    onStreamDone,
    onStreamEvent,
    includeToolCallsInTranscript: true,
    modelIdOverride,
  })
}
