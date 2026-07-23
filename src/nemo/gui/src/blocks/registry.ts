import { AgentBlock } from '@/blocks/blocks/agent'
import { ApiBlock } from '@/blocks/blocks/api'
import { ApiTriggerBlock } from '@/blocks/blocks/api_trigger'
import { ApplyFuncBlock } from '@/blocks/blocks/apply_func'
import { BrowserUseBlock } from '@/blocks/blocks/browser_use'
import { ConditionBlock } from '@/blocks/blocks/condition'
import { DatasetReaderBlock } from '@/blocks/blocks/dataset_reader'
import { DatasetWriterBlock } from '@/blocks/blocks/dataset_writer'
import { FileBlock } from '@/blocks/blocks/file'
import { FilterBlock } from '@/blocks/blocks/filter'
import { FunctionBlock } from '@/blocks/blocks/function'
import { GenerateEmbeddingBlock } from '@/blocks/blocks/generate_embedding'
import { HumanInTheLoopBlock } from '@/blocks/blocks/human_in_the_loop'
import { GenericWebhookBlock } from '@/blocks/blocks/generic_webhook'
import { GroupByAggBlock } from '@/blocks/blocks/groupby_agg'
import { JoinBlock } from '@/blocks/blocks/join'
import { ManualTriggerBlock } from '@/blocks/blocks/manual_trigger'
import { MemoryBlock } from '@/blocks/blocks/memory'
import { PublishToKbBlock } from '@/blocks/blocks/publish_to_kb'
import { ResponseBlock } from '@/blocks/blocks/response'
import { RouterBlock } from '@/blocks/blocks/router'
import { ScheduleBlock } from '@/blocks/blocks/schedule'
import { SqlBlock } from '@/blocks/blocks/sql'
import { StartTriggerBlock } from '@/blocks/blocks/start_trigger'
import { StarterBlock } from '@/blocks/blocks/starter'
import { VariablesBlock } from '@/blocks/blocks/variables'
import { WaitBlock } from '@/blocks/blocks/wait'
import { WebhookBlock } from '@/blocks/blocks/webhook'
import { WorkflowBlock } from '@/blocks/blocks/workflow'
import { WorkflowInputBlock } from '@/blocks/blocks/workflow_input'
import type { BlockConfig } from '@/blocks/types'

// Registry of all available blocks, alphabetically sorted
export const registry: Record<string, BlockConfig> = {
  agent: AgentBlock,
  api: ApiBlock,
  api_trigger: ApiTriggerBlock,
  apply_func: ApplyFuncBlock,
  browser_use: BrowserUseBlock,
  condition: ConditionBlock,
  dataset_reader: DatasetReaderBlock,
  dataset_writer: DatasetWriterBlock,
  file: FileBlock,
  filter: FilterBlock,
  function: FunctionBlock,
  generate_embedding: GenerateEmbeddingBlock,
  generic_webhook: GenericWebhookBlock,
  groupby_agg: GroupByAggBlock,
  human_in_the_loop: HumanInTheLoopBlock,
  join: JoinBlock,
  manual_trigger: ManualTriggerBlock,
  memory: MemoryBlock,
  publish_to_kb: PublishToKbBlock,
  response: ResponseBlock,
  router: RouterBlock,
  schedule: ScheduleBlock,
  sql: SqlBlock,
  starter: StarterBlock,
  start_trigger: StartTriggerBlock,
  variables: VariablesBlock,
  wait: WaitBlock,
  webhook: WebhookBlock,
  workflow: WorkflowBlock,
  workflow_input: WorkflowInputBlock,
}

export const getBlock = (type: string): BlockConfig | undefined => registry[type]

export const getBlocksByCategory = (category: 'blocks' | 'tools' | 'triggers'): BlockConfig[] =>
  Object.values(registry).filter((block) => block.category === category)

export const getAllBlockTypes = (): string[] => Object.keys(registry)

export const isValidBlockType = (type: string): type is string => type in registry

export const getAllBlocks = (): BlockConfig[] => Object.values(registry)
