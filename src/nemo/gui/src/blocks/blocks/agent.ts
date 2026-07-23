import { AgentIcon } from '@/components/icons'
import type { BlockConfig } from '@/blocks/types'

export const AgentBlock: BlockConfig = {
  type: 'agent',
  name: 'Agent',
  description: 'Invoke a pre-configured agent',
  longDescription:
    'The Agent block invokes an existing agent that has been configured in your project. Provide the project ID, agent ID, and a message. The block sends the message to the agent-service, which handles model selection, tool calls, and knowledge base retrieval based on the agent\'s saved configuration.',
  docsLink: 'https://docs.agentstudio.io/blocks/agent',
  category: 'blocks',
  bgColor: '#9333EA',
  icon: AgentIcon,
  subBlocks: [
    {
      id: 'projectId',
      title: 'Project',
      type: 'dropdown',
      placeholder: 'Select a project...',
      required: true,
    },
    {
      id: 'agentId',
      title: 'Agent',
      type: 'dropdown',
      placeholder: 'Select an agent...',
      required: true,
      dependsOn: ['projectId'],
    },
    {
      id: 'message',
      title: 'Message',
      type: 'long-input',
      placeholder: 'Enter the message to send to the agent...',
      required: true,
    },
    {
      id: 'sessionId',
      title: 'Session ID',
      type: 'short-input',
      placeholder: 'Optional session ID for conversation continuity',
    },
  ],
  tools: {
    access: ['agent_invoke'],
  },
  inputs: {
    projectId: { type: 'string', description: 'Project that owns the agent' },
    agentId: { type: 'string', description: 'ID of the pre-configured agent to invoke' },
    message: { type: 'string', description: 'Message to send to the agent' },
    sessionId: { type: 'string', description: 'Optional session ID for multi-turn conversations' },
  },
  outputs: {
    content: { type: 'string', description: 'Agent response content' },
    sessionId: { type: 'string', description: 'Session ID for follow-up messages' },
    model: { type: 'string', description: 'Model used by the agent' },
    latencyMs: { type: 'number', description: 'Response latency in milliseconds' },
    citations: { type: 'json', description: 'Knowledge base citations, if any' },
  },
}
