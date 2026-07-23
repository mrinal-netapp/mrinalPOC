// Shared override bundle used by single / A-B / sweep runs (spec §5.3).

export interface AgentRuntimeOverrides {
  // Agent / model binding
  agentSnapshotId?: string;
  model?: string;
  modelVersion?: string;

  // Generation knobs
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  seed?: number;
  stopSequences?: string[];
  frequencyPenalty?: number;
  presencePenalty?: number;
  repetitionPenalty?: number;
  responseFormat?: 'text' | 'json_object' | { schemaId: string };

  // Retrieval knobs
  topKRetrieval?: number;
  chunkSize?: number;
  chunkOverlap?: number;
  rerank?: boolean;
  rerankerModel?: string;
  retrievalThreshold?: number;
  maxContextTokens?: number;
  retrievalStrategy?: 'semantic' | 'keyword' | 'hybrid';
  hybridAlpha?: number;

  // Agent / orchestration knobs
  promptVariant?: string;
  systemPromptOverride?: string;
  toolSelectionStrategy?: 'auto' | 'force' | 'none';
  enabledTools?: string[];
  maxToolCalls?: number;
  maxSubAgentHops?: number;

  extra?: Record<string, string | number | boolean>;
}

export type TunableParamId =
  | 'temperature'
  | 'topP'
  | 'topK'
  | 'maxTokens'
  | 'frequencyPenalty'
  | 'presencePenalty'
  | 'repetitionPenalty'
  | 'stopSequences'
  | 'responseFormat'
  | 'topKRetrieval'
  | 'chunkSize'
  | 'chunkOverlap'
  | 'rerank'
  | 'rerankerModel'
  | 'retrievalThreshold'
  | 'maxContextTokens'
  | 'retrievalStrategy'
  | 'hybridAlpha'
  | 'model'
  | 'promptVariant'
  | 'toolSelectionStrategy'
  | 'enabledTools'
  | 'maxToolCalls'
  | 'maxSubAgentHops';

export type SweepParamId = TunableParamId;
