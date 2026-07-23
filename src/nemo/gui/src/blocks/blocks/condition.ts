import { ConditionalIcon } from '@/components/icons'
import type { BlockConfig } from '@/blocks/types'

export const ConditionBlock: BlockConfig = {
  type: 'condition',
  name: 'Condition',
  description: 'Add a condition',
  longDescription:
    'This is a core workflow block. Add a condition to the workflow to branch the execution path based on a boolean expression.',
  bestPractices: `
  - Write the conditions using standard javascript syntax except referencing the outputs of previous blocks using <> syntax, and keep them as simple as possible. No hacky fallbacks.
  - Can reference workflow variables using <blockName.output> syntax as usual within conditions.
  `,
  docsLink: 'https://docs.agentstudio.io/blocks/condition',
  bgColor: '#F59E0B', // Amber-500 - Control Flow theme
  icon: ConditionalIcon,
  category: 'blocks',
  subBlocks: [
    {
      id: 'conditions',
      type: 'condition-input',
    },
  ],
  tools: {
    access: [],
  },
  inputs: {},
  outputs: {
    content: { type: 'string', description: 'Condition evaluation content' },
    conditionResult: { type: 'boolean', description: 'Condition result' },
    selectedPath: { type: 'json', description: 'Selected execution path' },
    selectedConditionId: { type: 'string', description: 'Selected condition identifier' },
  },
}
