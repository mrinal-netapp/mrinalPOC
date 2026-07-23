import type { SVGProps } from 'react'
import { createElement } from 'react'
import { UserCheck } from 'lucide-react'
import type { BlockConfig } from '@/blocks/types'

const HILIcon = (props: SVGProps<SVGSVGElement>) => createElement(UserCheck, props)

export const HumanInTheLoopBlock: BlockConfig = {
  type: 'human_in_the_loop',
  name: 'Human in the Loop',
  description: 'Pause pipeline for human approval before proceeding',
  longDescription:
    'Pauses pipeline execution and sends a notification. Waits for a human to approve or reject items before the pipeline continues.',
  bestPractices: `
  - Use after analysis or recommendation steps to gate destructive actions.
  - Configure a notification channel (Slack) so approvers are alerted.
  - Set a reasonable timeout (default 7 days).
  - The upstream step should output an array of items with unique IDs for row-level approval.
  `,
  category: 'blocks',
  bgColor: '#F59E0B', // Amber-500
  icon: HILIcon,

  subBlocks: [
    {
      id: 'notification',
      type: 'dropdown',
      title: 'Notification Channel',
      options: [
        { label: 'Slack', id: 'slack' },
        { label: 'Email', id: 'email' },
        { label: 'None (manual check)', id: 'none' },
      ],
      required: true,
    },
    {
      id: 'timeout',
      type: 'short-input',
      title: 'Timeout',
      placeholder: '168h (7 days)',
      description: 'Duration to wait for approval (Go duration format: 168h, 24h, etc.)',
      required: false,
    },
    {
      id: 'webhookUrl',
      type: 'short-input',
      title: 'Slack Webhook URL',
      placeholder: 'https://hooks.slack.com/services/...',
      password: true,
      condition: { field: 'notification', value: 'slack' },
    },
    {
      id: 'message',
      type: 'long-input',
      title: 'Notification Message',
      placeholder: 'Pipeline requires your approval. Review recommendations and approve/reject.',
      rows: 3,
    },
  ],

  tools: {
    access: [],
  },

  inputs: {
    data: { type: 'json', description: 'Data to present for approval (typically recommendations array)' },
  },

  outputs: {
    approvedItems: { type: 'array', description: 'Items approved by the reviewer' },
    approvedIds: { type: 'array', description: 'IDs of approved items' },
    rejectedIds: { type: 'array', description: 'IDs of rejected items' },
  },
}
