export type ManagerRoleTemplateId =
  | 'coordinator'
  | 'planner'
  | 'reviewer'
  | 'router'
  | 'custom'

export type OrchestrationPolicy = 'coordinate' | 'route' | 'collaborate' | 'sequential'

export const MANAGER_ROLE_TEMPLATES: Array<{
  id: Exclude<ManagerRoleTemplateId, 'custom'>
  label: string
  role: string
}> = [
  { id: 'coordinator', label: 'Coordinator', role: 'Coordinate task decomposition and synthesis' },
  { id: 'planner', label: 'Planner', role: 'Plan multi-step execution and assign sub-tasks' },
  { id: 'reviewer', label: 'Reviewer', role: 'Review member outputs for correctness and quality' },
  { id: 'router', label: 'Router', role: 'Route requests to the best member for completion' },
]

export const ORCHESTRATION_PROMPT_TEMPLATES: Record<OrchestrationPolicy, string> = {
  coordinate:
    'You are the team manager. Coordinate members, ask each for targeted contributions, and return a unified final response.',
  route:
    'You are the team manager. Route each request to the most appropriate member and avoid unnecessary parallel work.',
  collaborate:
    'You are the team manager. Enable collaboration between members, merge overlapping ideas, and resolve conflicts before finalizing.',
  sequential:
    'You are the team manager. Execute work sequentially: gather member output step-by-step and carry forward validated context.',
}

