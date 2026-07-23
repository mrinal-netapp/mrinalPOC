/**
 * Provider utilities
 * Stub implementation for pipeline editor
 */

import type React from 'react'
import type { ProviderId } from './types'

export const providers: Record<string, { models?: string[] }> = {
  'azure-openai': {
    models: [],
  },
}

export function getAllModelProviders(): Record<ProviderId, string> {
  return {}
}

export function getHostedModels(): string[] {
  return []
}

export function getProviderIcon(_model: string): React.ComponentType<{ className?: string }> | null {
  return null
}

export function getMaxTemperature(_model: string): number {
  return 2
}

export const MODELS_WITH_REASONING_EFFORT: string[] = []

export const MODELS_WITH_VERBOSITY: string[] = []

export function supportsTemperature(_model: string): boolean {
  return true
}

