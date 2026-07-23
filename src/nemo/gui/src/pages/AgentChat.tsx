import { useParams } from 'react-router-dom'
import { agentApi, agentInvokeApi } from '../services/api'
import { useAgentRuntime } from '../hooks/useAgentRuntime'
import ChatPage from '../components/chat/ChatPage'

const agentSessionApi = {
  listSessions: (projectId: string, agentId: string) =>
    agentInvokeApi.listSessions(projectId, agentId),
  renameSession: (projectId: string, agentId: string, sessionId: string, name: string) =>
    agentInvokeApi.renameSession(projectId, agentId, sessionId, name),
  deleteSession: (projectId: string, agentId: string, sessionId: string) =>
    agentInvokeApi.deleteSession(projectId, agentId, sessionId),
}

export default function AgentChat() {
  const { projectId, agentId } = useParams<{ projectId: string; agentId: string }>()

  if (!projectId || !agentId) return null

  return (
    <ChatPage
      projectId={projectId}
      entityId={agentId}
      entityLabel="Agent"
      fetchEntity={() => agentApi.get(projectId, agentId)}
      sessionApi={agentSessionApi}
      useRuntime={useAgentRuntime}
      backPath={`/projects/${projectId}/agents`}
      backLabel="Go back to agents"
    />
  )
}
