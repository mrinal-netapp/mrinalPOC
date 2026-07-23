import { create } from 'zustand'
import type { WorkflowState } from '@/stores/workflow/types'
import { generateUUID } from '@/lib/uuid'

export interface PipelineTab {
  id: string
  name: string
  workflowState: WorkflowState
  projectId?: string
  pipelineId?: string
  pipelineType?: 'data' | 'api'
  isDirty?: boolean
}

interface PipelineTabsState {
  tabs: PipelineTab[]
  activeTabId: string | null
  addTab: (tab: Omit<PipelineTab, 'id'>) => string
  removeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  updateTabName: (tabId: string, name: string) => void
  updateTabWorkflow: (tabId: string, workflowState: WorkflowState) => void
  getActiveTab: () => PipelineTab | null
  getTab: (tabId: string) => PipelineTab | null
}

const initialWorkflowState: WorkflowState = {
  blocks: {},
  edges: [],
  lastSaved: undefined,
}

export const usePipelineTabsStore = create<PipelineTabsState>()((set, get) => ({
  tabs: [],
  activeTabId: null,

  addTab: (tab) => {
    const id = generateUUID()
    const newTab: PipelineTab = {
      id,
      name: tab.name || `Pipeline ${get().tabs.length + 1}`,
      workflowState: tab.workflowState || { ...initialWorkflowState },
      projectId: tab.projectId,
      pipelineId: tab.pipelineId,
      pipelineType: tab.pipelineType,
      isDirty: tab.isDirty || false,
    }
    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: id,
    }))
    return id
  },

  removeTab: (tabId) => {
    set((state) => {
      const newTabs = state.tabs.filter((tab) => tab.id !== tabId)
      let newActiveTabId = state.activeTabId

      // If removing the active tab, switch to another tab
      if (state.activeTabId === tabId) {
        if (newTabs.length > 0) {
          // Switch to the tab that was before this one, or the first tab
          const removedIndex = state.tabs.findIndex((t) => t.id === tabId)
          const newIndex = removedIndex > 0 ? removedIndex - 1 : 0
          newActiveTabId = newTabs[newIndex]?.id || null
        } else {
          newActiveTabId = null
        }
      }

      return {
        tabs: newTabs,
        activeTabId: newActiveTabId,
      }
    })
  },

  setActiveTab: (tabId) => {
    set({ activeTabId: tabId })
  },

  updateTabName: (tabId, name) => {
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, name: name.trim() || tab.name } : tab
      ),
    }))
  },

  updateTabWorkflow: (tabId, workflowState) => {
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, workflowState, isDirty: true } : tab
      ),
    }))
  },

  getActiveTab: () => {
    const state = get()
    return state.tabs.find((tab) => tab.id === state.activeTabId) || null
  },

  getTab: (tabId) => {
    return get().tabs.find((tab) => tab.id === tabId) || null
  },
}))

