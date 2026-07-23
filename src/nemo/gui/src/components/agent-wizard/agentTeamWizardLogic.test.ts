import { deriveManagerName, resolveManagerRole, shouldAutoRegeneratePrompt } from './agentTeamWizardLogic'

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`agentTeamWizardLogic.test failed: ${message}`)
  }
}

// Minimal zero-dependency checks so logic remains regression-safe
{
  assert(deriveManagerName('Research Team') === 'Research Team Manager', 'derive manager name')
  assert(deriveManagerName('') === 'Team Manager', 'derive manager fallback')

  assert(
    resolveManagerRole('coordinator', '') === 'Coordinate task decomposition and synthesis',
    'resolve template role',
  )
  assert(resolveManagerRole('custom', 'My custom role') === 'My custom role', 'resolve custom role')

  assert(shouldAutoRegeneratePrompt('auto') === true, 'auto prompt regeneration')
  assert(shouldAutoRegeneratePrompt('custom') === false, 'custom prompt lock')
}

