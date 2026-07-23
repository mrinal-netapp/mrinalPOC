import {
  Badge,
  Card,
  Checkbox,
  Combobox,
  Dropdown,
  Field,
  Input,
  Label,
  Link,
  Option,
  Radio,
  RadioGroup,
  Text,
  Textarea,
} from '@fluentui/react-components'
import { Agent, AgentTeam, Model } from '../../services/api'
import {
  MANAGER_ROLE_TEMPLATES,
  ManagerRoleTemplateId,
  ORCHESTRATION_PROMPT_TEMPLATES,
  OrchestrationPolicy,
} from './agentTeamTemplates'

export interface TeamFormData {
  name: string
  description?: string
  orchestrationPolicy: 'coordinate' | 'route' | 'collaborate' | 'sequential'
  manager: {
    name: string
    role?: string
    modelId?: string
    modelClass?: string
    systemPrompt: string
    temperature?: number
    maxTokens?: number
  }
  members: Array<{ memberType: 'agent' | 'team'; memberId: string; role?: string }>
}

const DEFAULT_MODEL_CLASSES = ['reasoning', 'balanced', 'fast', 'code']

interface AgentTeamWizardProps {
  step: number
  formData: TeamFormData
  updateFormField: (field: keyof TeamFormData, value: any) => void
  agents: Agent[]
  teams: AgentTeam[]
  models: Model[]
  modelClasses?: string[]
  managerNameAutoSync: boolean
  onManagerNameAutoSyncChange: (enabled: boolean) => void
  managerRoleTemplate: ManagerRoleTemplateId
  onManagerRoleTemplateChange: (role: ManagerRoleTemplateId) => void
  managerRoleCustomValue: string
  onManagerRoleCustomValueChange: (value: string) => void
  promptSource: 'auto' | 'custom'
  promptTemplateOutdated: boolean
  onPromptEdited: () => void
  onResetPromptToTemplate: () => void
  modelsLoadError?: string | null
}

export function AgentTeamWizard({
  step,
  formData,
  updateFormField,
  agents,
  teams,
  models,
  modelClasses = [],
  managerNameAutoSync,
  onManagerNameAutoSyncChange,
  managerRoleTemplate,
  onManagerRoleTemplateChange,
  managerRoleCustomValue,
  onManagerRoleCustomValueChange,
  promptSource,
  promptTemplateOutdated,
  onPromptEdited,
  onResetPromptToTemplate,
  modelsLoadError,
}: AgentTeamWizardProps) {
  if (step === 1) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <Field label="Team Name" required>
          <Input value={formData.name} onChange={(_, d) => updateFormField('name', d.value)} />
        </Field>
        <Field label="Description">
          <Textarea
            value={formData.description || ''}
            onChange={(_, d) => updateFormField('description', d.value)}
            rows={3}
          />
        </Field>
      </div>
    )
  }

  if (step === 2) {
    const managerModelMode: 'specific' | 'class' = formData.manager.modelClass ? 'class' : 'specific'
    const selectedModel = models.find(m => m.id === formData.manager.modelId)
    const allClassOptions = Array.from(
      new Set([...DEFAULT_MODEL_CLASSES, ...modelClasses]),
    ).sort()

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <Field label="Manager Name">
          <Input
            value={formData.manager.name}
            onChange={(_, d) => {
              onManagerNameAutoSyncChange(false)
              updateFormField('manager', { ...formData.manager, name: d.value })
            }}
          />
        </Field>
        <Checkbox
          checked={managerNameAutoSync}
          onChange={(_, d) => onManagerNameAutoSyncChange(!!d.checked)}
          label="Sync manager name with team name"
        />
        <Field label="Manager Role Template">
          <Dropdown
            value={
              managerRoleTemplate === 'custom'
                ? 'Custom'
                : (MANAGER_ROLE_TEMPLATES.find(t => t.id === managerRoleTemplate)?.label || 'Coordinator')
            }
            selectedOptions={[managerRoleTemplate]}
            onOptionSelect={(_, d) => onManagerRoleTemplateChange((d.optionValue || 'coordinator') as ManagerRoleTemplateId)}
          >
            {MANAGER_ROLE_TEMPLATES.map(template => (
              <Option key={template.id} value={template.id}>
                {template.label}
              </Option>
            ))}
            <Option value="custom">Custom...</Option>
          </Dropdown>
        </Field>
        {managerRoleTemplate === 'custom' && (
          <Field label="Custom Manager Role">
            <Input
              value={managerRoleCustomValue}
              onChange={(_, d) => onManagerRoleCustomValueChange(d.value)}
            />
          </Field>
        )}
        <Field label="Manager Model Selection Mode">
          <RadioGroup
            value={managerModelMode}
            onChange={(_, d) => {
              if (d.value === 'specific') {
                updateFormField('manager', { ...formData.manager, modelClass: undefined })
              } else {
                updateFormField('manager', { ...formData.manager, modelId: undefined })
              }
            }}
          >
            <Radio value="specific" label="Specific Model" />
            <Radio value="class" label="Model Class" />
          </RadioGroup>
        </Field>
        {managerModelMode === 'specific' ? (
          <Field label="Manager Model" required>
            <Dropdown
              value={selectedModel ? `${selectedModel.provider} / ${selectedModel.providerModelId}` : ''}
              selectedOptions={formData.manager.modelId ? [formData.manager.modelId] : []}
              onOptionSelect={(_, d) => updateFormField('manager', { ...formData.manager, modelId: d.optionValue || '' })}
              placeholder="Select manager model"
            >
              {models.map(m => (
                <Option key={m.id} value={m.id} text={`${m.provider} / ${m.providerModelId}`}>
                  {m.provider} / {m.providerModelId}
                </Option>
              ))}
            </Dropdown>
          </Field>
        ) : (
          <Field label="Manager Model Class" required>
            <Combobox
              freeform
              value={formData.manager.modelClass || ''}
              selectedOptions={formData.manager.modelClass ? [formData.manager.modelClass] : []}
              onOptionSelect={(_, d) => updateFormField('manager', { ...formData.manager, modelClass: d.optionValue })}
              onChange={(e) => updateFormField('manager', { ...formData.manager, modelClass: (e.target as HTMLInputElement).value })}
              placeholder="e.g., reasoning, balanced, fast, code"
            >
              {allClassOptions.map(c => (
                <Option key={c} value={c} text={c}>{c}</Option>
              ))}
            </Combobox>
          </Field>
        )}
        {modelsLoadError && (
          <Text size={200} style={{ color: 'var(--colorPaletteRedForeground1)' }}>
            {modelsLoadError}
          </Text>
        )}
        <Field label="Manager System Prompt" required>
          <Textarea
            value={formData.manager.systemPrompt}
            onChange={(_, d) => {
              onPromptEdited()
              updateFormField('manager', { ...formData.manager, systemPrompt: d.value })
            }}
            rows={4}
          />
        </Field>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
            Prompt source: {promptSource === 'auto' ? 'template' : 'custom'}
            {promptTemplateOutdated ? ' (strategy changed)' : ''}
          </Text>
          <Link onClick={onResetPromptToTemplate}>Reset to template</Link>
        </div>
      </div>
    )
  }

  if (step === 3) {
    const members = formData.members || []
    const hasMember = (memberType: 'agent' | 'team', memberId: string) =>
      members.some(m => m.memberType === memberType && m.memberId === memberId)
    const toggle = (memberType: 'agent' | 'team', memberId: string, checked?: boolean) => {
      if (checked) {
        updateFormField('members', [...members, { memberType, memberId }])
      } else {
        updateFormField(
          'members',
          members.filter(m => !(m.memberType === memberType && m.memberId === memberId))
        )
      }
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <Label weight="semibold">Select Members</Label>
        <Text size={200}>Agents</Text>
        {agents.map(agent => (
          <Card key={agent.id} size="small" style={{ padding: '8px 10px' }}>
            <Checkbox
              checked={hasMember('agent', agent.id)}
              onChange={(_, d) => toggle('agent', agent.id, !!d.checked)}
              label={`${agent.name} (${agent.id})`}
            />
          </Card>
        ))}
        <Text size={200} style={{ marginTop: '8px' }}>Teams</Text>
        {teams.map(team => (
          <Card key={team.id} size="small" style={{ padding: '8px 10px' }}>
            <Checkbox
              checked={hasMember('team', team.id)}
              onChange={(_, d) => toggle('team', team.id, !!d.checked)}
              label={`${team.name} (${team.id})`}
            />
          </Card>
        ))}
      </div>
    )
  }

  if (step === 4) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <Field label="Orchestration Policy">
          <Dropdown
            value={formData.orchestrationPolicy}
            selectedOptions={[formData.orchestrationPolicy]}
            onOptionSelect={(_, d) => updateFormField('orchestrationPolicy', (d.optionValue || 'coordinate') as OrchestrationPolicy)}
          >
            <Option value="coordinate">Coordinate</Option>
            <Option value="route">Route</Option>
            <Option value="collaborate">Collaborate</Option>
            <Option value="sequential">Sequential</Option>
          </Dropdown>
        </Field>
        <Card size="small" style={{ padding: '8px 10px' }}>
          <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
            Default prompt preview for this strategy:
          </Text>
          <Text size={200}>{ORCHESTRATION_PROMPT_TEMPLATES[formData.orchestrationPolicy]}</Text>
          {promptTemplateOutdated && (
            <Text size={200} style={{ color: 'var(--colorPaletteMarigoldForeground1)', marginTop: '6px' }}>
              Strategy changed after prompt customization. Use reset to apply this strategy template.
            </Text>
          )}
        </Card>
      </div>
    )
  }

  if (step === 5) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <Text weight="semibold">Review Team</Text>
        <Card size="small" style={{ padding: '10px' }}>
          <div><Text size={200}>Name:</Text> {formData.name}</div>
          <div><Text size={200}>Policy:</Text> {formData.orchestrationPolicy}</div>
          <div><Text size={200}>Manager Name:</Text> {formData.manager.name}</div>
          <div><Text size={200}>Manager Role:</Text> {formData.manager.role || '-'}</div>
          <div><Text size={200}>Manager Model:</Text> {formData.manager.modelClass ? `Class: ${formData.manager.modelClass} (auto-selected)` : (models.find(m => m.id === formData.manager.modelId)?.providerModelId || formData.manager.modelId || 'Not selected')}</div>
          <div><Text size={200}>Prompt Source:</Text> {promptSource === 'auto' ? 'template' : 'custom'}</div>
          <div><Text size={200}>Members:</Text> {formData.members.length}</div>
          <div style={{ marginTop: '8px', display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
            {formData.members.map(m => (
              <Badge key={`${m.memberType}:${m.memberId}`} appearance="outline">
                {m.memberType}: {m.memberId}
              </Badge>
            ))}
          </div>
        </Card>
      </div>
    )
  }

  return null
}
