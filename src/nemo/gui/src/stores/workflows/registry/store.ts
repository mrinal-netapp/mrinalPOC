/**
 * Workflows registry store
 * Stub implementation for pipeline editor
 */

import { create } from 'zustand'

interface WorkflowInfo {
  name?: string
  [key: string]: any
}

interface WorkflowRegistryState {
  workflows: Record<string, WorkflowInfo>
  activeWorkflowId?: string
}

export const useWorkflowRegistry = create<WorkflowRegistryState>()(() => ({
  workflows: {},
  activeWorkflowId: undefined,
}))

