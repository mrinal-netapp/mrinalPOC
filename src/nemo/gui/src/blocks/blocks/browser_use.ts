import { BrowserUseIcon } from '@/components/icons'
import { AuthMode, type BlockConfig } from '@/blocks/types'

export const BrowserUseBlock: BlockConfig = {
  type: 'browser_use',
  name: 'Browser Use',
  description: 'Run browser automation tasks',
  authMode: AuthMode.ApiKey,
  longDescription:
    'Integrate Browser Use into the workflow. Can navigate the web and perform actions as if a real user was interacting with the browser.',
  docsLink: 'https://docs.agentstudio.io/tools/browser_use',
  category: 'tools',
  bgColor: '#6B7280', // Gray-500 - Tools/Utilities theme
  icon: BrowserUseIcon,
  subBlocks: [
    {
      id: 'task',
      title: 'Task',
      type: 'long-input',
      placeholder: 'Describe what the browser agent should do...',
      required: true,
    },
    {
      id: 'variables',
      title: 'Variables (Secrets)',
      type: 'table',
      columns: ['Key', 'Value'],
    },
    {
      id: 'model',
      title: 'Model',
      type: 'dropdown',
      options: [
        { label: 'gpt-4o', id: 'gpt-4o' },
        { label: 'gemini-2.0-flash', id: 'gemini-2.0-flash' },
        { label: 'gemini-2.0-flash-lite', id: 'gemini-2.0-flash-lite' },
        { label: 'claude-3-7-sonnet-20250219', id: 'claude-3-7-sonnet-20250219' },
        { label: 'llama-4-maverick-17b-128e-instruct', id: 'llama-4-maverick-17b-128e-instruct' },
      ],
    },
    {
      id: 'save_browser_data',
      title: 'Save Browser Data',
      type: 'switch',
      placeholder: 'Save browser data',
    },
    {
      id: 'apiKey',
      title: 'API Key',
      type: 'short-input',
      password: true,
      placeholder: 'Enter your BrowserUse API key',
      required: true,
    },
  ],
  tools: {
    access: ['browser_use_run_task'],
  },
  inputs: {
    task: { type: 'string', description: 'Browser automation task' },
    apiKey: { type: 'string', description: 'BrowserUse API key' },
    variables: { type: 'json', description: 'Task variables' },
    model: { type: 'string', description: 'AI model to use' },
    save_browser_data: { type: 'boolean', description: 'Save browser data' },
  },
  outputs: {
    id: { type: 'string', description: 'Task execution identifier' },
    success: { type: 'boolean', description: 'Task completion status' },
    output: { type: 'json', description: 'Task output data' },
    steps: { type: 'json', description: 'Execution steps taken' },
  },
}
