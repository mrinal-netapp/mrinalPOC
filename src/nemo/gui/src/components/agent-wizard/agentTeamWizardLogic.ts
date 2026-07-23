import { MANAGER_ROLE_TEMPLATES, ManagerRoleTemplateId } from './agentTeamTemplates'

export function deriveManagerName(teamName: string): string {
  const trimmed = teamName.trim()
  return `${trimmed || 'Team'} Manager`
}

export function resolveManagerRole(
  templateId: ManagerRoleTemplateId,
  customValue: string,
): string {
  if (templateId === 'custom') return customValue.trim()
  return MANAGER_ROLE_TEMPLATES.find(t => t.id === templateId)?.role || ''
}

export function shouldAutoRegeneratePrompt(promptSource: 'auto' | 'custom'): boolean {
  return promptSource === 'auto'
}

