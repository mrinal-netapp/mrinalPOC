import { useRef, useState } from 'react'
import {
  Field,
  Input,
  Textarea,
  Dropdown,
  Option,
  Slider,
  Checkbox,
  Label,
  Badge,
  Text,
  Card,
  Divider,
  SpinButton,
  RadioGroup,
  Radio,
  Combobox,
  Button,
} from '@fluentui/react-components'
import { ChevronDown16Regular, ChevronRight16Regular } from '@fluentui/react-icons'
import { CreateAgentRequest, MCPServer, Model, KnowledgeBase } from '../../services/api'
import {
  fetchProviderContextWindow,
  suggestedMaxOutputTokens,
  suggestedMaxTokensForModelClass,
} from '../../utils/modelMaxTokens'

function KnowledgeBaseStep({
  formData,
  updateFormField,
  knowledgeBases,
}: {
  formData: CreateAgentRequest
  updateFormField: (field: keyof CreateAgentRequest, value: any) => void
  knowledgeBases: KnowledgeBase[]
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const selectedKbIds = new Set(formData.knowledgeBaseIds || [])
  const hasKbs = (formData.knowledgeBaseIds?.length ?? 0) > 0

  const updateRag = (patch: Partial<{ topK: number; similarityThreshold: number; searchMode: string }>) => {
    updateFormField('ragConfig', {
      topK: formData.ragConfig?.topK ?? 5,
      similarityThreshold: formData.ragConfig?.similarityThreshold ?? 0.7,
      searchMode: formData.ragConfig?.searchMode ?? 'semantic',
      ...patch,
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <Label weight="semibold">Select Knowledge Bases</Label>
      {knowledgeBases.length === 0 && (
        <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
          No knowledge bases available. Create one from the Knowledge Bases page.
        </Text>
      )}
      {knowledgeBases.map(kb => (
        <Card key={kb.id} size="small" style={{ padding: '8px 12px' }}>
          <Checkbox
            checked={selectedKbIds.has(kb.id)}
            onChange={(_, d) => {
              const current = formData.knowledgeBaseIds || []
              if (d.checked) {
                updateFormField('knowledgeBaseIds', [...current, kb.id])
              } else {
                updateFormField('knowledgeBaseIds', current.filter(id => id !== kb.id))
              }
            }}
            label={
              <div>
                <Text weight="semibold">{kb.name}</Text>
                <Text size={200} style={{ display: 'block', color: 'var(--colorNeutralForeground3)' }}>
                  {kb.status} &middot; {kb.embeddingModel || 'default embedding'}
                </Text>
              </div>
            }
          />
        </Card>
      ))}
      {hasKbs && (
        <>
          <Divider style={{ margin: '8px 0' }} />
          <Button
            appearance="subtle"
            size="small"
            icon={advancedOpen ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
            onClick={() => setAdvancedOpen(!advancedOpen)}
            style={{ alignSelf: 'flex-start' }}
          >
            Advanced Retrieval Settings
          </Button>
          {advancedOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', paddingLeft: '8px' }}>
              <Field label="Search Mode">
                <Dropdown
                  value={formData.ragConfig?.searchMode || 'semantic'}
                  selectedOptions={[formData.ragConfig?.searchMode || 'semantic']}
                  onOptionSelect={(_, d) => updateRag({ searchMode: d.optionValue as string })}
                >
                  <Option value="semantic" text="Semantic">Semantic</Option>
                  <Option value="hybrid" text="Hybrid">Hybrid</Option>
                  <Option value="fts" text="Full-Text Search">Full-Text Search</Option>
                </Dropdown>
              </Field>
              <Field label={`Top-K Results: ${formData.ragConfig?.topK ?? 5}`}>
                <Slider
                  min={1}
                  max={20}
                  value={formData.ragConfig?.topK ?? 5}
                  onChange={(_, d) => updateRag({ topK: d.value })}
                />
              </Field>
              <Field label={`Relevance Threshold: ${(formData.ragConfig?.similarityThreshold ?? 0.7).toFixed(2)}`}>
                <Slider
                  min={0}
                  max={1}
                  step={0.05}
                  value={formData.ragConfig?.similarityThreshold ?? 0.7}
                  onChange={(_, d) => updateRag({ similarityThreshold: d.value })}
                />
                <Text size={200} style={{ color: 'var(--colorNeutralForeground3)', marginTop: '4px' }}>
                  Only include results with similarity score above this threshold. Lower values return more results but may reduce relevance.
                </Text>
              </Field>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export interface AgentWizardProps {
  step: number
  formData: CreateAgentRequest
  updateFormField: (field: keyof CreateAgentRequest, value: any) => void
  /** Used to load provider catalog (context windows) when a specific model is chosen */
  projectId: string
  mcpServers: MCPServer[]
  models: Model[]
  knowledgeBases: KnowledgeBase[]
  modelClasses?: string[]
}

const DEFAULT_MODEL_CLASSES = ['reasoning', 'balanced', 'fast', 'code']

export function AgentWizard({
  step,
  formData,
  updateFormField,
  projectId,
  mcpServers,
  models,
  knowledgeBases,
  modelClasses = [],
}: AgentWizardProps) {
  const maxTokensSuggestionEpoch = useRef(0)

  // Step 1: Identity & Role
  if (step === 1) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <Field label="Agent Name" required>
          <Input
            value={formData.name || ''}
            onChange={(_, d) => updateFormField('name', d.value)}
            placeholder="e.g., Customer Support Agent"
          />
        </Field>
        <Field label="Description">
          <Textarea
            value={formData.description || ''}
            onChange={(_, d) => updateFormField('description', d.value)}
            placeholder="Brief description of what this agent does"
            rows={2}
          />
        </Field>
        <Field label="Role" required>
          <Input
            value={formData.role || ''}
            onChange={(_, d) => updateFormField('role', d.value)}
            placeholder="e.g., Customer Support Specialist"
          />
        </Field>
        <Field label="System Prompt" required>
          <Textarea
            value={formData.systemPrompt || ''}
            onChange={(_, d) => updateFormField('systemPrompt', d.value)}
            placeholder="You are a helpful customer support agent..."
            rows={6}
            style={{ fontFamily: 'monospace', fontSize: '13px' }}
          />
        </Field>
      </div>
    )
  }

  // Step 2: Model
  if (step === 2) {
    const modelMode: 'specific' | 'class' = formData.modelClass ? 'class' : 'specific'
    const selectedModel = models.find(m => m.id === formData.modelId)

    const allClassOptions = Array.from(
      new Set([...DEFAULT_MODEL_CLASSES, ...modelClasses]),
    ).sort()

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <Field label="Model Selection Mode">
          <RadioGroup
            value={modelMode}
            onChange={(_, d) => {
              if (d.value === 'specific') {
                updateFormField('modelClass', undefined as any)
              } else {
                updateFormField('modelId', undefined as any)
              }
            }}
          >
            <Radio value="specific" label="Specific Model" />
            <Radio value="class" label="Model Class" />
          </RadioGroup>
        </Field>

        {modelMode === 'specific' ? (
          <Field label="Model" required>
            <Dropdown
              value={selectedModel ? `${selectedModel.provider} / ${selectedModel.providerModelId}` : ''}
              selectedOptions={formData.modelId ? [formData.modelId] : []}
              onOptionSelect={(_, d) => {
                const newId = d.optionValue as string
                updateFormField('modelId', newId)
                const m = models.find(x => x.id === newId)
                const epoch = ++maxTokensSuggestionEpoch.current
                const quick = suggestedMaxOutputTokens(m?.providerModelId, undefined)
                updateFormField('maxTokens', quick)
                if (!projectId || !m) return
                void fetchProviderContextWindow(projectId, m).then((cw) => {
                  if (maxTokensSuggestionEpoch.current !== epoch) return
                  updateFormField(
                    'maxTokens',
                    suggestedMaxOutputTokens(m.providerModelId, cw)
                  )
                })
              }}
              placeholder="Select a model"
            >
              {models.map(m => (
                <Option key={m.id} value={m.id} text={`${m.provider} / ${m.providerModelId}`}>
                  {m.provider} / {m.providerModelId}
                </Option>
              ))}
            </Dropdown>
          </Field>
        ) : (
          <Field label="Model Class" required>
            <Combobox
              freeform
              value={formData.modelClass || ''}
              selectedOptions={formData.modelClass ? [formData.modelClass] : []}
              onOptionSelect={(_, d) => {
                const cls = (d.optionValue as string) || ''
                updateFormField('modelClass', cls)
                updateFormField('maxTokens', suggestedMaxTokensForModelClass(cls))
              }}
              onChange={(e) => updateFormField('modelClass', (e.target as HTMLInputElement).value)}
              placeholder="e.g., reasoning, balanced, fast, code"
            >
              {allClassOptions.map(c => (
                <Option key={c} value={c} text={c}>{c}</Option>
              ))}
            </Combobox>
          </Field>
        )}

        {models.length === 0 && (
          <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
            No models registered. Add models in the Models page first.
          </Text>
        )}
        <Field label={`Temperature: ${formData.temperature ?? 0.7}`}>
          <Slider
            min={0}
            max={2}
            step={0.1}
            value={formData.temperature ?? 0.7}
            onChange={(_, d) => updateFormField('temperature', d.value)}
          />
        </Field>
        <Field label="Max tokens (completion)">
          <SpinButton
            value={formData.maxTokens ?? 8192}
            min={1}
            max={131072}
            step={256}
            onChange={(_, d) => updateFormField('maxTokens', d.value ?? 8192)}
          />
          <Text size={200} style={{ color: 'var(--colorNeutralForeground3)', marginTop: '6px', display: 'block' }}>
            Choosing a specific model updates this to a typical output limit for that family. Choosing a model class uses a default for that class. You can still override.
          </Text>
        </Field>
      </div>
    )
  }

  // Step 3: MCP Servers
  if (step === 3) {
    const selectedIds = new Set(formData.mcpServerIds || [])
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <Label weight="semibold">Select MCP Servers</Label>
        {mcpServers.length === 0 && (
          <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
            No MCP servers configured. Add servers in the MCP Servers page first.
          </Text>
        )}
        {mcpServers.map(server => (
          <Card key={server.id} size="small" style={{ padding: '8px 12px' }}>
            <Checkbox
              checked={selectedIds.has(server.id)}
              onChange={(_, d) => {
                const current = formData.mcpServerIds || []
                if (d.checked) {
                  updateFormField('mcpServerIds', [...current, server.id])
                } else {
                  updateFormField('mcpServerIds', current.filter(id => id !== server.id))
                }
              }}
              label={
                <div>
                  <Text weight="semibold">{server.name}</Text>
                  <Text size={200} style={{ display: 'block', color: 'var(--colorNeutralForeground3)' }}>
                    {server.transport.toUpperCase()} — {server.url || server.command || 'No connection info'}
                  </Text>
                  <Badge
                    appearance="filled"
                    color={server.syncStatus === 'synced' ? 'success' : server.syncStatus === 'error' ? 'danger' : 'warning'}
                    style={{ marginTop: '4px' }}
                  >
                    {server.syncStatus}
                  </Badge>
                </div>
              }
            />
          </Card>
        ))}
      </div>
    )
  }

  // Step 4: Knowledge Bases
  if (step === 4) {
    return <KnowledgeBaseStep formData={formData} updateFormField={updateFormField} knowledgeBases={knowledgeBases} />
  }

  // Step 5: Outcomes
  if (step === 5) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <Field label="Expected Outcome Description">
          <Textarea
            value={formData.outcomeDescription || ''}
            onChange={(_, d) => updateFormField('outcomeDescription', d.value)}
            placeholder="Describe the expected output format..."
            rows={3}
          />
        </Field>
        <Field label="Output JSON Schema (optional)">
          <Textarea
            value={formData.outcomeSchema ? JSON.stringify(formData.outcomeSchema, null, 2) : ''}
            onChange={(_, d) => {
              try {
                const parsed = d.value.trim() ? JSON.parse(d.value) : undefined
                updateFormField('outcomeSchema', parsed)
              } catch {
                // Allow typing invalid JSON temporarily
              }
            }}
            placeholder='{"type": "object", "properties": { ... }}'
            rows={6}
            style={{ fontFamily: 'monospace', fontSize: '13px' }}
          />
        </Field>
        <Divider style={{ margin: '4px 0' }} />
        <Field label="Memory Type">
          <Dropdown
            value={formData.memoryType || 'conversation'}
            selectedOptions={[formData.memoryType || 'conversation']}
            onOptionSelect={(_, d) => updateFormField('memoryType', d.optionValue)}
          >
            <Option value="none" text="None">None</Option>
            <Option value="conversation" text="Conversation">Conversation</Option>
            <Option value="sliding_window" text="Sliding Window">Sliding Window</Option>
          </Dropdown>
        </Field>
        {formData.memoryType === 'sliding_window' && (
          <Field label="Window Size">
            <SpinButton
              value={formData.memoryConfig?.windowSize ?? 10}
              min={1}
              max={100}
              onChange={(_, d) => updateFormField('memoryConfig', { windowSize: d.value ?? 10 })}
            />
          </Field>
        )}
      </div>
    )
  }

  // Step 3 (simplified flow) or legacy Step 6: Review
  if (step === 3 || step === 6) {
    const selectedModel = models.find(m => m.id === formData.modelId)
    const selectedServers = mcpServers.filter(s => (formData.mcpServerIds || []).includes(s.id))
    const selectedKBs = knowledgeBases.filter(kb => (formData.knowledgeBaseIds || []).includes(kb.id))

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <Text size={400} weight="semibold">Review Agent Configuration</Text>

        <Card size="small" style={{ padding: '12px' }}>
          <Text weight="semibold" size={300}>Identity</Text>
          <div style={{ marginTop: '8px' }}>
            <div><Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>Name:</Text> {formData.name}</div>
            <div><Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>Role:</Text> {formData.role}</div>
            {formData.description && (
              <div><Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>Description:</Text> {formData.description}</div>
            )}
          </div>
        </Card>

        <Card size="small" style={{ padding: '12px' }}>
          <Text weight="semibold" size={300}>Model</Text>
          <div style={{ marginTop: '8px' }}>
            {formData.modelClass ? (
              <div><Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>Class:</Text> {formData.modelClass} (auto-selected)</div>
            ) : (
              <div>{selectedModel ? `${selectedModel.provider} / ${selectedModel.providerModelId}` : 'Not selected'}</div>
            )}
            <div><Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>Temperature:</Text> {formData.temperature ?? 0.7}</div>
            {formData.maxTokens && (
              <div><Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>Max Tokens:</Text> {formData.maxTokens}</div>
            )}
          </div>
        </Card>

        {selectedServers.length > 0 && (
          <Card size="small" style={{ padding: '12px' }}>
            <Text weight="semibold" size={300}>MCP Servers ({selectedServers.length})</Text>
            <div style={{ marginTop: '8px', display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
              {selectedServers.map(s => <Badge key={s.id} appearance="outline">{s.name}</Badge>)}
            </div>
          </Card>
        )}

        {selectedKBs.length > 0 && (
          <Card size="small" style={{ padding: '12px' }}>
            <Text weight="semibold" size={300}>Knowledge Bases ({selectedKBs.length})</Text>
            <div style={{ marginTop: '8px', display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
              {selectedKBs.map(kb => <Badge key={kb.id} appearance="outline">{kb.name}</Badge>)}
            </div>
            {formData.ragConfig && (
              <div style={{ marginTop: '4px' }}>
                <Text size={200}>
                  Search: {formData.ragConfig.searchMode} &middot; Top-K: {formData.ragConfig.topK} &middot; Threshold: {formData.ragConfig.similarityThreshold}
                </Text>
              </div>
            )}
          </Card>
        )}

        <Card size="small" style={{ padding: '12px' }}>
          <Text weight="semibold" size={300}>Memory & Output</Text>
          <div style={{ marginTop: '8px' }}>
            <div><Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>Memory:</Text> {formData.memoryType || 'conversation'}</div>
            {formData.outcomeDescription && (
              <div><Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>Outcome:</Text> {formData.outcomeDescription}</div>
            )}
            {formData.outcomeSchema && (
              <div><Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>Output Schema:</Text> Defined</div>
            )}
          </div>
        </Card>
      </div>
    )
  }

  return null
}
