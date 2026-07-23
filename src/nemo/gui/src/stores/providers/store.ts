/**
 * Providers store
 * Stub implementation for pipeline editor
 */

import { create } from 'zustand'

interface ProvidersState {
  providers: {
    base?: { models?: string[] }
    ollama?: { models?: string[] }
    openrouter?: { models?: string[] }
  }
}

export const useProvidersStore = create<ProvidersState>()(() => ({
  providers: {
    base: { models: [] },
    ollama: { models: [] },
    openrouter: { models: [] },
  },
}))

