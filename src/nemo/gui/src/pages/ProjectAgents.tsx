import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  makeStyles,
  tokens,
  Card,
  Text,
  Button,
  Spinner,
  MessageBar,
  MessageBarBody,
  Table,
  TableHeader,
  TableHeaderCell,
  TableBody,
  TableRow,
  TableCell,
  Badge,
  Input,
  Checkbox,
  Tooltip,
  Link,
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogActions,
  DialogContent,
} from '@fluentui/react-components'
import {
  Add24Regular,
  Edit24Regular,
  Delete24Regular,
  Search24Regular,
  Bot24Regular,
  ChatMultiple24Regular,
  Play24Regular,
} from '@fluentui/react-icons'
import {
  agentApi,
  Agent,
  AgentTeam,
  agentTeamApi,
  CreateAgentRequest,
  mcpServerApi,
  MCPServer,
  modelApi,
  Model,
  knowledgeBaseApi,
  KnowledgeBase,
  DependentsPage,
  getApiErrorMessage,
  getDependentsFromError,
} from '../services/api'
import { DependentsCell, DependentsBlockerList } from '../components/DependentsCell'
import { WizardModal } from '../components/wizard/WizardModal'
import { AgentWizard } from '../components/agent-wizard/AgentWizard'
import { AgentTeamWizard, TeamFormData } from '../components/agent-wizard/AgentTeamWizard'
import {
  MANAGER_ROLE_TEMPLATES,
  ManagerRoleTemplateId,
  ORCHESTRATION_PROMPT_TEMPLATES,
} from '../components/agent-wizard/agentTeamTemplates'
import {
  deriveManagerName,
  resolveManagerRole,
  shouldAutoRegeneratePrompt,
} from '../components/agent-wizard/agentTeamWizardLogic'
import { useToast } from '../contexts/ToastContext'

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  searchBar: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    marginBottom: '8px',
  },
  card: {
    padding: '16px',
  },
  segmentBar: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
  },
  segmentButtons: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
  },
  summaryBadges: {
    display: 'flex',
    gap: '6px',
    alignItems: 'center',
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '48px',
    gap: '12px',
    color: tokens.colorNeutralForeground3,
  },
  chatNameLink: {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    background: 'none',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    color: tokens.colorBrandForeground1,
    font: 'inherit',
    ':hover': {
      textDecoration: 'underline',
    },
  },
})

const WIZARD_STEPS = [
  { number: 1, title: 'Identity', description: 'Name, role, and prompt' },
  { number: 2, title: 'Model', description: 'LLM selection' },
  { number: 3, title: 'MCP Servers', description: 'Tooling integrations' },
  { number: 4, title: 'Knowledge Bases', description: 'RAG knowledge sources' },
  { number: 5, title: 'Outcomes', description: 'Output and memory settings' },
  { number: 6, title: 'Review', description: 'Confirm & save' },
]

const DEFAULT_FORM_DATA: CreateAgentRequest = {
  name: '',
  description: '',
  role: '',
  systemPrompt: '',
  modelId: '',
  temperature: 0.7,
  maxTokens: 8192,
  mcpServerIds: [],
  knowledgeBaseIds: [],
  memoryType: 'conversation',
}

const TEAM_WIZARD_STEPS = [
  { number: 1, title: 'Identity', description: 'Team identity' },
  { number: 2, title: 'Manager', description: 'Embedded manager config' },
  { number: 3, title: 'Members', description: 'Agents and teams' },
  { number: 4, title: 'Orchestration', description: 'Execution policy' },
  { number: 5, title: 'Review', description: 'Confirm team' },
]

const DEFAULT_TEAM_FORM_DATA: TeamFormData = {
  name: '',
  description: '',
  orchestrationPolicy: 'coordinate',
  manager: {
    name: 'Team Manager',
    role: '',
    modelId: '',
    systemPrompt: ORCHESTRATION_PROMPT_TEMPLATES.coordinate,
  },
  members: [],
}

export default function ProjectAgents() {
  const styles = useStyles()
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const { showToast } = useToast()

  const [agents, setAgents] = useState<Agent[]>([])
  const [teams, setTeams] = useState<AgentTeam[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeView, setActiveView] = useState<'agents' | 'teams' | 'all'>('all')

  // Wizard state
  const [showWizard, setShowWizard] = useState(false)
  const [wizardStep, setWizardStep] = useState(1)
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [formData, setFormData] = useState<CreateAgentRequest>({ ...DEFAULT_FORM_DATA })

  // Reference data for wizard dropdowns
  const [mcpServers, setMcpServers] = useState<MCPServer[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [modelClasses, setModelClasses] = useState<string[]>([])
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([])

  // Playground selection
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set())

  // Delete state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [agentToDelete, setAgentToDelete] = useState<Agent | null>(null)
  const [agentDeleteBlockers, setAgentDeleteBlockers] = useState<DependentsPage | null>(null)
  const [agentDeleting, setAgentDeleting] = useState(false)
  const [teamToDelete, setTeamToDelete] = useState<AgentTeam | null>(null)
  const [teamDeleteDialogOpen, setTeamDeleteDialogOpen] = useState(false)
  const [teamDeleteBlockers, setTeamDeleteBlockers] = useState<DependentsPage | null>(null)
  const [teamDeleting, setTeamDeleting] = useState(false)

  const [showTeamWizard, setShowTeamWizard] = useState(false)
  const [teamWizardStep, setTeamWizardStep] = useState(1)
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null)
  const [teamFormError, setTeamFormError] = useState<string | null>(null)
  const [teamSubmitting, setTeamSubmitting] = useState(false)
  const [teamFormData, setTeamFormData] = useState<TeamFormData>({ ...DEFAULT_TEAM_FORM_DATA })
  const [managerNameAutoSync, setManagerNameAutoSync] = useState(true)
  const [managerRoleTemplate, setManagerRoleTemplate] = useState<ManagerRoleTemplateId>('coordinator')
  const [managerRoleCustomValue, setManagerRoleCustomValue] = useState('')
  const [promptSource, setPromptSource] = useState<'auto' | 'custom'>('auto')
  const [promptTemplateOutdated, setPromptTemplateOutdated] = useState(false)
  const [modelsLoadError, setModelsLoadError] = useState<string | null>(null)

  const loadAgents = useCallback(async () => {
    if (!projectId) return
    try {
      setLoading(true)
      setError(null)
      const data = await agentApi.list(projectId)
      setAgents(data)
    } catch (err: any) {
      setError(err.message || 'Failed to load agents')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  const loadTeams = useCallback(async () => {
    if (!projectId) return
    try {
      const data = await agentTeamApi.list(projectId)
      setTeams(data)
    } catch (err) {
      console.error('Failed to load teams', err)
    }
  }, [projectId])

  const loadReferenceData = useCallback(async () => {
    if (!projectId) return
    try {
      const [t, m, kb, mc] = await Promise.all([
        mcpServerApi.list(projectId),
        modelApi.list(projectId),
        knowledgeBaseApi.list(projectId),
        modelApi.listClasses(projectId).catch(() => [] as string[]),
      ])
      setMcpServers(t)
      setModels(m)
      setKnowledgeBases(kb)
      setModelClasses(mc)
    } catch (err: any) {
      console.error('Failed to load reference data:', err)
      setModelsLoadError('Models unavailable. Please retry loading reference data.')
    }
  }, [projectId])

  useEffect(() => {
    loadAgents()
    loadTeams()
    loadReferenceData()
  }, [loadAgents, loadReferenceData, loadTeams])

  const filteredAgents = agents.filter(a =>
    a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    a.role.toLowerCase().includes(searchQuery.toLowerCase()) ||
    a.id.toLowerCase().includes(searchQuery.toLowerCase())
  )
  const filteredTeams = teams.filter(t =>
    t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.orchestrationPolicy.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.id.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const resetForm = () => {
    setFormData({ ...DEFAULT_FORM_DATA })
    setWizardStep(1)
    setEditingAgentId(null)
    setFormError(null)
  }

  const updateFormField = (field: keyof CreateAgentRequest, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

  const nextStep = () => {
    setFormError(null)
    if (wizardStep === 1) {
      if (!formData.name?.trim()) return setFormError('Name is required')
      if (!formData.role?.trim()) return setFormError('Role is required')
      if (!formData.systemPrompt?.trim()) return setFormError('System prompt is required')
    }
    if (wizardStep === 2) {
      if (!formData.modelId && !formData.modelClass) return setFormError('Please select a model or model class')
    }
    setWizardStep(prev => Math.min(prev + 1, WIZARD_STEPS.length))
  }

  const prevStep = () => {
    setFormError(null)
    setWizardStep(prev => Math.max(prev - 1, 1))
  }

  const handleCreate = () => {
    resetForm()
    setShowWizard(true)
  }

  const resetTeamForm = () => {
    setTeamFormData({
      ...DEFAULT_TEAM_FORM_DATA,
      manager: {
        ...DEFAULT_TEAM_FORM_DATA.manager,
        name: 'Team Manager',
      },
    })
    setManagerNameAutoSync(true)
    setManagerRoleTemplate('coordinator')
    setManagerRoleCustomValue('')
    setPromptSource('auto')
    setPromptTemplateOutdated(false)
    setTeamWizardStep(1)
    setEditingTeamId(null)
    setTeamFormError(null)
  }

  const updateTeamFormField = (field: keyof TeamFormData, value: any) => {
    setTeamFormData(prev => {
      const next = { ...prev, [field]: value }
      if (field === 'name' && managerNameAutoSync) {
        next.manager = { ...next.manager, name: deriveManagerName(String(value || '')) }
      }
      if (field === 'orchestrationPolicy') {
        const policy = value as keyof typeof ORCHESTRATION_PROMPT_TEMPLATES
        const template = ORCHESTRATION_PROMPT_TEMPLATES[policy]
        if (shouldAutoRegeneratePrompt(promptSource)) {
          next.manager = { ...next.manager, systemPrompt: template }
        } else {
          setPromptTemplateOutdated(true)
        }
      }
      return next
    })
  }

  const handleCreateTeam = () => {
    resetTeamForm()
    setTeamFormData(prev => ({
      ...prev,
      manager: { ...prev.manager, name: `${prev.name || 'Team'} Manager` },
    }))
    setShowTeamWizard(true)
  }

  const nextTeamStep = () => {
    setTeamFormError(null)
    if (teamWizardStep === 1 && !teamFormData.name.trim()) return setTeamFormError('Team name is required')
    if (teamWizardStep === 2) {
      if (!teamFormData.manager.modelId?.trim() && !teamFormData.manager.modelClass?.trim()) return setTeamFormError('Manager model or model class is required')
      if (!teamFormData.manager.systemPrompt.trim()) return setTeamFormError('Manager prompt is required')
    }
    if (teamWizardStep === 2 && (modelsLoadError || models.length === 0)) {
      return setTeamFormError(modelsLoadError || 'No models available for manager selection')
    }
    if (teamWizardStep === 3 && teamFormData.members.length === 0) return setTeamFormError('At least one member is required')
    setTeamWizardStep(prev => Math.min(prev + 1, TEAM_WIZARD_STEPS.length))
  }

  const prevTeamStep = () => {
    setTeamFormError(null)
    setTeamWizardStep(prev => Math.max(prev - 1, 1))
  }

  const handleEditTeam = (team: AgentTeam) => {
    setEditingTeamId(team.id)
    setTeamFormData({
      name: team.name,
      description: team.description,
      orchestrationPolicy: team.orchestrationPolicy,
      manager: team.manager || { name: '', modelId: '', systemPrompt: '' },
      members: team.members || [],
    })
    setManagerNameAutoSync(false)
    const matchedTemplate = MANAGER_ROLE_TEMPLATES.find(t => t.role === (team.manager?.role || ''))
    if (matchedTemplate) {
      setManagerRoleTemplate(matchedTemplate.id)
      setManagerRoleCustomValue('')
    } else {
      setManagerRoleTemplate('custom')
      setManagerRoleCustomValue(team.manager?.role || '')
    }
    setPromptSource('custom')
    setPromptTemplateOutdated(false)
    setShowTeamWizard(true)
    setTeamWizardStep(1)
  }

  const handleSubmitTeam = async () => {
    if (!projectId) return
    try {
      setTeamSubmitting(true)
      setTeamFormError(null)
      const resolvedRole =
        resolveManagerRole(managerRoleTemplate, managerRoleCustomValue)
      const payload: TeamFormData = {
        ...teamFormData,
        manager: {
          ...teamFormData.manager,
          name: teamFormData.manager.name.trim() || deriveManagerName(teamFormData.name),
          role: resolvedRole,
        },
      }
      if (editingTeamId) {
        await agentTeamApi.update(projectId, editingTeamId, payload)
        showToast('Team updated successfully', 'success')
      } else {
        await agentTeamApi.create(projectId, payload)
        showToast('Team created successfully', 'success')
      }
      setShowTeamWizard(false)
      resetTeamForm()
      loadTeams()
    } catch (err: any) {
      setTeamFormError(err.response?.data?.error || err.message || 'Failed to save team')
    } finally {
      setTeamSubmitting(false)
    }
  }

  const handleEdit = async (agent: Agent) => {
    setEditingAgentId(agent.id)
    setFormData({
      name: agent.name,
      description: agent.description,
      role: agent.role,
      systemPrompt: agent.systemPrompt,
      modelId: agent.modelId,
      temperature: agent.temperature,
      maxTokens: agent.maxTokens,
      mcpServerIds: agent.mcpServerIds || [],
      mcpServerConfig: agent.mcpServerConfig,
      knowledgeBaseIds: agent.knowledgeBaseIds || [],
      ragConfig: agent.ragConfig,
      outcomeSchema: agent.outcomeSchema,
      outcomeDescription: agent.outcomeDescription,
      memoryType: agent.memoryType || 'conversation',
      memoryConfig: agent.memoryConfig,
      guardrails: agent.guardrails,
    })
    setWizardStep(1)
    setShowWizard(true)
  }

  const handleSubmit = async () => {
    if (!projectId) return
    setSubmitting(true)
    setFormError(null)
    try {
      if (editingAgentId) {
        await agentApi.update(projectId, editingAgentId, formData)
        showToast('Agent updated successfully', 'success')
      } else {
        await agentApi.create(projectId, formData)
        showToast('Agent created successfully', 'success')
      }
      setShowWizard(false)
      resetForm()
      loadAgents()
    } catch (err: any) {
      setFormError(err.response?.data?.error || err.message || 'Failed to save agent')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDeleteConfirm = async () => {
    if (!projectId || !agentToDelete) return
    try {
      setAgentDeleting(true)
      await agentApi.delete(projectId, agentToDelete.id)
      showToast('Agent deleted', 'success')
      setDeleteDialogOpen(false)
      setAgentToDelete(null)
      setAgentDeleteBlockers(null)
      loadAgents()
    } catch (err: unknown) {
      const msg = getApiErrorMessage(err, 'Failed to delete agent')
      const blockers = getDependentsFromError(err)
      if (blockers) {
        setAgentDeleteBlockers(blockers)
        showToast(msg, 'warning')
      } else {
        showToast(msg, 'error')
      }
    } finally {
      setAgentDeleting(false)
    }
  }

  if (loading) {
    return <Spinner label="Loading agents..." />
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <Text size={500} weight="semibold">Agents</Text>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Tooltip
            content={selectedAgentIds.size < 2
              ? 'Select 2 or more agents to compare'
              : `Compare ${selectedAgentIds.size} agents`}
            relationship="label"
          >
            <Button
              appearance="secondary"
              icon={<Play24Regular />}
              disabled={selectedAgentIds.size < 2}
              onClick={() => {
                const ids = Array.from(selectedAgentIds).join(',')
                navigate(`/projects/${projectId}/agents/playground?agents=${ids}`)
              }}
            >
              Playground ({selectedAgentIds.size})
            </Button>
          </Tooltip>
          <Button appearance="primary" icon={<Add24Regular />} onClick={handleCreate}>
            Create Agent
          </Button>
          <Button appearance="secondary" icon={<Add24Regular />} onClick={handleCreateTeam}>
            Create Team
          </Button>
        </div>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.searchBar}>
        <Search24Regular />
        <Input
          value={searchQuery}
          onChange={(_, d) => setSearchQuery(d.value)}
          placeholder={
            activeView === 'agents'
              ? 'Search agents by name, role, or ID...'
              : activeView === 'teams'
                ? 'Search teams by name, policy, or ID...'
                : 'Search agents/teams by name, role/policy, or ID...'
          }
          style={{ flex: 1 }}
        />
      </div>

      <div className={styles.segmentBar}>
        <div className={styles.segmentButtons}>
          <Button appearance={activeView === 'all' ? 'primary' : 'secondary'} size="small" onClick={() => setActiveView('all')}>
            All
          </Button>
          <Button appearance={activeView === 'agents' ? 'primary' : 'secondary'} size="small" onClick={() => setActiveView('agents')}>
            Agents
          </Button>
          <Button appearance={activeView === 'teams' ? 'primary' : 'secondary'} size="small" onClick={() => setActiveView('teams')}>
            Teams
          </Button>
        </div>
        <div className={styles.summaryBadges}>
          <Badge appearance="outline">Agents: {agents.length}</Badge>
          <Badge appearance="outline" color="informative">Teams: {teams.length}</Badge>
        </div>
      </div>

      {activeView === 'agents' && filteredAgents.length === 0 && !loading && (
        <div className={styles.emptyState}>
          <Bot24Regular style={{ fontSize: '48px' }} />
          <Text size={300}>
            {searchQuery ? 'No agents match your search' : 'No agents yet. Create your first agent!'}
          </Text>
        </div>
      )}

      {activeView === 'teams' && filteredTeams.length === 0 && !loading && (
        <div className={styles.emptyState}>
          <ChatMultiple24Regular style={{ fontSize: '48px' }} />
          <Text size={300}>
            {searchQuery ? 'No teams match your search' : 'No teams yet. Create your first team!'}
          </Text>
        </div>
      )}

      {(activeView === 'all' || activeView === 'agents') && (
        <Card className={styles.card}>
          <Text size={400} weight="semibold" style={{ marginBottom: '8px', display: 'block' }}>
            Agents
          </Text>
          {filteredAgents.length === 0 ? (
            <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
              {searchQuery ? 'No agents match your search.' : 'No agents yet.'}
            </Text>
          ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell style={{ width: '40px' }}>
                  <Checkbox
                    checked={filteredAgents.length > 0 && filteredAgents.every(a => selectedAgentIds.has(a.id))
                      ? true
                      : filteredAgents.some(a => selectedAgentIds.has(a.id))
                        ? 'mixed'
                        : false}
                    onChange={(_, data) => {
                      if (data.checked) {
                        setSelectedAgentIds(new Set(filteredAgents.map(a => a.id)))
                      } else {
                        setSelectedAgentIds(new Set())
                      }
                    }}
                  />
                </TableHeaderCell>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Role</TableHeaderCell>
                <TableHeaderCell>Model</TableHeaderCell>
                <TableHeaderCell>Resources</TableHeaderCell>
                <TableHeaderCell>Used by</TableHeaderCell>
                <TableHeaderCell>Updated</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredAgents.map(agent => {
                const model = models.find(m => m.id === agent.modelId)
                return (
                  <TableRow key={agent.id}>
                    <TableCell>
                      <Checkbox
                        checked={selectedAgentIds.has(agent.id)}
                        onChange={(_, data) => {
                          setSelectedAgentIds(prev => {
                            const next = new Set(prev)
                            if (data.checked) next.add(agent.id)
                            else next.delete(agent.id)
                            return next
                          })
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      <Link
                        as="button"
                        type="button"
                        className={styles.chatNameLink}
                        onClick={() => {
                          if (!projectId) return
                          navigate(`/projects/${projectId}/agents/${agent.id}/chat`)
                        }}
                        title="Open chat"
                      >
                        <Text weight="semibold" as="span">{agent.name}</Text>
                        <Text size={200} style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>
                          {agent.id}
                        </Text>
                      </Link>
                    </TableCell>
                    <TableCell>{agent.role}</TableCell>
                    <TableCell>
                      {model ? `${model.provider} / ${model.providerModelId}` : agent.modelId}
                    </TableCell>
                    <TableCell>
                      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                        {(agent.mcpServerIds || []).length > 0 && (
                          <Badge appearance="outline">{agent.mcpServerIds.length} MCP servers</Badge>
                        )}
                        {(agent.knowledgeBaseIds || []).length > 0 && (
                          <Badge appearance="outline" color="brand">{agent.knowledgeBaseIds.length} KBs</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {projectId && (
                        <DependentsCell
                          projectId={projectId}
                          targetKind="agent"
                          targetId={agent.id}
                          summary={agent.dependentsSummary}
                        />
                      )}
                    </TableCell>
                    <TableCell>
                      {new Date(agent.updatedAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <Button
                          icon={<ChatMultiple24Regular />}
                          size="small"
                          appearance="subtle"
                          onClick={() => navigate(`/projects/${projectId}/agents/${agent.id}/chat`)}
                          title="Chat with Agent"
                        />
                        <Button
                          icon={<Edit24Regular />}
                          size="small"
                          appearance="subtle"
                          onClick={() => handleEdit(agent)}
                          title="Edit Agent"
                        />
                        <Button
                          icon={<Delete24Regular />}
                          size="small"
                          appearance="subtle"
                          onClick={() => { setAgentToDelete(agent); setAgentDeleteBlockers(null); setDeleteDialogOpen(true) }}
                          title="Delete Agent"
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          )}
        </Card>
      )}

      {(activeView === 'all' || activeView === 'teams') && (
        <Card className={styles.card}>
          <Text size={400} weight="semibold" style={{ marginBottom: '8px', display: 'block' }}>Teams</Text>
          {filteredTeams.length === 0 ? (
            <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
              {searchQuery ? 'No teams match your search.' : 'No teams yet.'}
            </Text>
          ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Policy</TableHeaderCell>
                <TableHeaderCell>Members</TableHeaderCell>
                <TableHeaderCell>Used by</TableHeaderCell>
                <TableHeaderCell>Updated</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredTeams.map(team => (
                <TableRow key={team.id}>
                  <TableCell>
                    <Link
                      as="button"
                      type="button"
                      className={styles.chatNameLink}
                      onClick={() => {
                        if (!projectId) return
                        navigate(`/projects/${projectId}/agent-teams/${team.id}/chat`)
                      }}
                      title="Open team chat"
                    >
                      <Text weight="semibold" as="span">{team.name}</Text>
                      <Text size={200} style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>{team.id}</Text>
                    </Link>
                  </TableCell>
                  <TableCell>{team.orchestrationPolicy}</TableCell>
                  <TableCell>{team.members?.length || 0}</TableCell>
                  <TableCell>
                    {projectId && (
                      <DependentsCell
                        projectId={projectId}
                        targetKind="agent_team"
                        targetId={team.id}
                        summary={team.dependentsSummary}
                      />
                    )}
                  </TableCell>
                  <TableCell>{new Date(team.updatedAt).toLocaleDateString()}</TableCell>
                  <TableCell>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <Button
                        icon={<ChatMultiple24Regular />}
                        size="small"
                        appearance="subtle"
                        onClick={() => navigate(`/projects/${projectId}/agent-teams/${team.id}/chat`)}
                        title="Chat with Team"
                      />
                      <Button icon={<Edit24Regular />} size="small" appearance="subtle" onClick={() => handleEditTeam(team)} />
                      <Button
                        icon={<Delete24Regular />}
                        size="small"
                        appearance="subtle"
                        onClick={() => { setTeamToDelete(team); setTeamDeleteBlockers(null); setTeamDeleteDialogOpen(true) }}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          )}
        </Card>
      )}

      {showWizard && (
        <WizardModal
          title={editingAgentId ? 'Edit Agent' : 'Create Agent'}
          onClose={() => { setShowWizard(false); resetForm() }}
          onSubmit={handleSubmit}
          submitting={submitting}
          formError={formError}
          currentStep={wizardStep}
          onNext={nextStep}
          onPrev={prevStep}
          steps={WIZARD_STEPS}
          submitLabel={editingAgentId ? 'Update Agent' : 'Create Agent'}
          mode={editingAgentId ? 'edit' : 'create'}
          onStepClick={(s) => { setFormError(null); setWizardStep(s) }}
        >
          <AgentWizard
            step={wizardStep}
            formData={formData}
            updateFormField={updateFormField}
            projectId={projectId || ''}
            mcpServers={mcpServers}
            models={models}
            knowledgeBases={knowledgeBases}
            modelClasses={modelClasses}
          />
        </WizardModal>
      )}

      {showTeamWizard && (
        <WizardModal
          title={editingTeamId ? 'Edit Team' : 'Create Team'}
          onClose={() => { setShowTeamWizard(false); resetTeamForm() }}
          onSubmit={handleSubmitTeam}
          submitting={teamSubmitting}
          formError={teamFormError}
          currentStep={teamWizardStep}
          onNext={nextTeamStep}
          onPrev={prevTeamStep}
          steps={TEAM_WIZARD_STEPS}
          submitLabel={editingTeamId ? 'Update Team' : 'Create Team'}
          mode={editingTeamId ? 'edit' : 'create'}
          onStepClick={(s) => { setTeamFormError(null); setTeamWizardStep(s) }}
        >
          <AgentTeamWizard
            step={teamWizardStep}
            formData={teamFormData}
            updateFormField={updateTeamFormField}
            agents={agents}
            teams={teams.filter(t => t.id !== editingTeamId)}
            models={models}
            modelClasses={modelClasses}
            managerNameAutoSync={managerNameAutoSync}
            onManagerNameAutoSyncChange={(enabled) => {
              setManagerNameAutoSync(enabled)
              if (enabled) {
                setTeamFormData(prev => ({
                  ...prev,
                  manager: { ...prev.manager, name: deriveManagerName(prev.name) },
                }))
              }
            }}
            managerRoleTemplate={managerRoleTemplate}
            onManagerRoleTemplateChange={(role) => {
              setManagerRoleTemplate(role)
              if (role !== 'custom') {
                const resolved = MANAGER_ROLE_TEMPLATES.find(t => t.id === role)?.role || ''
                setTeamFormData(prev => ({ ...prev, manager: { ...prev.manager, role: resolved } }))
              }
            }}
            managerRoleCustomValue={managerRoleCustomValue}
            onManagerRoleCustomValueChange={(value) => {
              setManagerRoleCustomValue(value)
              setTeamFormData(prev => ({ ...prev, manager: { ...prev.manager, role: value } }))
            }}
            promptSource={promptSource}
            promptTemplateOutdated={promptTemplateOutdated}
            onPromptEdited={() => setPromptSource('custom')}
            onResetPromptToTemplate={() => {
              setTeamFormData(prev => ({
                ...prev,
                manager: {
                  ...prev.manager,
                  systemPrompt: ORCHESTRATION_PROMPT_TEMPLATES[prev.orchestrationPolicy],
                },
              }))
              setPromptSource('auto')
              setPromptTemplateOutdated(false)
            }}
            modelsLoadError={modelsLoadError}
          />
        </WizardModal>
      )}

      <Dialog open={deleteDialogOpen} onOpenChange={(_, d) => {
        setDeleteDialogOpen(d.open)
        if (!d.open) {
          setAgentToDelete(null)
          setAgentDeleteBlockers(null)
        }
      }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete Agent</DialogTitle>
            <DialogContent>
              {agentDeleteBlockers ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <Text>
                    Cannot delete agent &quot;{agentToDelete?.name}&quot; while it is still in use by:
                  </Text>
                  {projectId && (
                    <DependentsBlockerList projectId={projectId} page={agentDeleteBlockers} />
                  )}
                  <Text style={{ marginTop: 4, color: tokens.colorNeutralForeground2 }}>
                    Update or remove these references, then try deleting again.
                  </Text>
                </div>
              ) : (
                <>Are you sure you want to delete agent <strong>{agentToDelete?.name}</strong>?
                This action cannot be undone.</>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDeleteDialogOpen(false)} disabled={agentDeleting}>
                {agentDeleteBlockers ? 'Close' : 'Cancel'}
              </Button>
              {!agentDeleteBlockers && (
                <Button appearance="primary" onClick={handleDeleteConfirm} disabled={agentDeleting}>
                  {agentDeleting ? 'Deleting...' : 'Delete'}
                </Button>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={teamDeleteDialogOpen} onOpenChange={(_, d) => {
        setTeamDeleteDialogOpen(d.open)
        if (!d.open) {
          setTeamToDelete(null)
          setTeamDeleteBlockers(null)
        }
      }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete Team</DialogTitle>
            <DialogContent>
              {teamDeleteBlockers ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <Text>
                    Cannot delete team &quot;{teamToDelete?.name}&quot; while it is still in use by:
                  </Text>
                  {projectId && (
                    <DependentsBlockerList projectId={projectId} page={teamDeleteBlockers} />
                  )}
                  <Text style={{ marginTop: 4, color: tokens.colorNeutralForeground2 }}>
                    Update or remove these references, then try deleting again.
                  </Text>
                </div>
              ) : (
                <>Are you sure you want to delete team <strong>{teamToDelete?.name}</strong>?</>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setTeamDeleteDialogOpen(false)} disabled={teamDeleting}>
                {teamDeleteBlockers ? 'Close' : 'Cancel'}
              </Button>
              {!teamDeleteBlockers && (
                <Button
                  appearance="primary"
                  disabled={teamDeleting}
                  onClick={async () => {
                    if (!projectId || !teamToDelete) return
                    try {
                      setTeamDeleting(true)
                      await agentTeamApi.delete(projectId, teamToDelete.id)
                      setTeamDeleteDialogOpen(false)
                      setTeamToDelete(null)
                      setTeamDeleteBlockers(null)
                      loadTeams()
                    } catch (err: unknown) {
                      const msg = getApiErrorMessage(err, 'Failed to delete team')
                      const blockers = getDependentsFromError(err)
                      if (blockers) {
                        setTeamDeleteBlockers(blockers)
                        showToast(msg, 'warning')
                      } else {
                        showToast(msg, 'error')
                      }
                    } finally {
                      setTeamDeleting(false)
                    }
                  }}
                >
                  {teamDeleting ? 'Deleting...' : 'Delete'}
                </Button>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  )
}
