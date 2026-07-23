import { modelApi, Model, ProviderModel } from '../services/api'

/** Upper bound for suggested max completion tokens (provider-specific caps vary). */
export const MAX_SUGGESTED_OUTPUT_TOKENS = 65536

/**
 * Suggested max_tokens (completion budget) for Bifrost / Agno from provider model id and optional context window.
 * Context window is total input+output budget; we derive a conservative completion cap.
 */
export function suggestedMaxOutputTokens(
  providerModelId: string | undefined,
  contextWindow?: number
): number {
  const id = (providerModelId || '').toLowerCase()

  // OpenAI-style reasoning models often allow very large completions
  if (/\bo3\b/.test(id) || id.startsWith('o1') || id.startsWith('o4') || id.includes('gpt-5')) {
    return Math.min(MAX_SUGGESTED_OUTPUT_TOKENS, 65536)
  }

  if (id.includes('claude') || id.includes('anthropic.')) {
    return 8192
  }
  if (id.includes('gemini') || id.includes('gemma')) {
    return 8192
  }
  if (id.includes('gpt-4o')) {
    return 16384
  }
  if (id.includes('gpt-4-turbo')) {
    return 4096
  }
  if (id.includes('gpt-4')) {
    return 8192
  }
  if (id.includes('gpt-3.5')) {
    return 4096
  }
  if (id.includes('llama3') || id.includes('llama-3') || id.includes('llama3.')) {
    return 8192
  }
  if (id.includes('mistral') || id.includes('mixtral')) {
    return 8192
  }
  if (id.includes('deepseek')) {
    return 8192
  }
  if (id.includes('amazon.') || id.includes('meta.')) {
    return 8192
  }

  if (contextWindow != null && contextWindow > 0) {
    const scaled = Math.min(
      MAX_SUGGESTED_OUTPUT_TOKENS,
      Math.max(4096, Math.floor(contextWindow / 16))
    )
    return scaled
  }

  return 8192
}

export function suggestedMaxTokensForModelClass(modelClass: string | undefined): number {
  const c = (modelClass || '').toLowerCase()
  if (c === 'reasoning') return 16384
  if (c === 'code') return 16384
  if (c === 'fast') return 4096
  if (c === 'balanced') return 8192
  return 8192
}

/**
 * Resolve context window from provider catalog (when available). Swallows errors (e.g. OpenAI without credential).
 */
export async function fetchProviderContextWindow(
  projectId: string,
  model: Model | undefined
): Promise<number | undefined> {
  if (!model?.provider || !model.providerModelId) return undefined

  try {
    const body: { provider: string; credentialId?: string; type?: 'llm' | 'embedding' } = {
      provider: model.provider,
      type: 'llm',
    }
    if (model.credentialId) {
      body.credentialId = model.credentialId
    }
    const result = await modelApi.listAvailable(projectId, body)
    const pm = findProviderModelMatch(result.models, model.providerModelId)
    return pm?.contextWindow
  } catch {
    return undefined
  }
}

function findProviderModelMatch(catalog: ProviderModel[], providerModelId: string): ProviderModel | undefined {
  const exact = catalog.find((m) => m.id === providerModelId)
  if (exact) return exact
  return catalog.find((m) => m.name === providerModelId)
}
