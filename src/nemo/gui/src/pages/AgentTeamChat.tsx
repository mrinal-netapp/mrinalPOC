import { useParams } from 'react-router-dom'
import { agentTeamApi, agentTeamInvokeApi } from '../services/api'
import { useAgentTeamRuntime } from '../hooks/useAgentTeamRuntime'
import ChatPage from '../components/chat/ChatPage'

const teamSessionApi = {
  listSessions: (projectId: string, teamId: string) =>
    agentTeamInvokeApi.listSessions(projectId, teamId),
  renameSession: (projectId: string, teamId: string, sessionId: string, name: string) =>
    agentTeamInvokeApi.renameSession(projectId, teamId, sessionId, name),
  deleteSession: (projectId: string, teamId: string, sessionId: string) =>
    agentTeamInvokeApi.deleteSession(projectId, teamId, sessionId),
}

export default function AgentTeamChat() {
  const { projectId, teamId } = useParams<{ projectId: string; teamId: string }>()

  if (!projectId || !teamId) return null

  return (
    <ChatPage
      projectId={projectId}
      entityId={teamId}
      entityLabel="Agent Team"
      fetchEntity={async () => {
        const team = await agentTeamApi.get(projectId, teamId)
        if (!team) return null
        return {
          name: team.name,
          description: team.description,
          modelId: team.manager?.modelId,
          modelClass: team.manager?.modelClass,
        }
      }}
      sessionApi={teamSessionApi}
      useRuntime={useAgentTeamRuntime}
      backPath={`/projects/${projectId}/agents`}
      backLabel="Go back to agents"
    />
  )
}
