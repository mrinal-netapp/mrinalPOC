import type { KBWorkflowOutcome } from '@/api/kb.types';
import { toast } from '@/ui-lib/base-components/toast/toast';

export type KBWorkflowToastContext = 'create' | 'update' | 'sync' | 'syncSettings';

const SUCCESS_MESSAGES: Record<KBWorkflowToastContext, { saved: string; reprocess: string }> = {
  create: {
    saved: 'Knowledge base created successfully.',
    reprocess: 'Knowledge base created. Reprocessing started.',
  },
  update: {
    saved: 'Knowledge base updated successfully.',
    reprocess: 'Knowledge base updated. Reprocessing started.',
  },
  sync: {
    saved: 'Synchronization started.',
    reprocess: 'Synchronization started.',
  },
  syncSettings: {
    saved: 'Synchronization settings updated successfully.',
    reprocess: 'Synchronization settings updated. Reprocessing started.',
  },
};

function workflowWarningMessage(outcome: KBWorkflowOutcome): string | undefined {
  return outcome.warning ?? outcome.workflowError;
}

export function showKBWorkflowOutcomeToast(
  context: KBWorkflowToastContext,
  outcome: KBWorkflowOutcome,
): void {
  const warnMsg = workflowWarningMessage(outcome);
  if (warnMsg) {
    toast.warning(warnMsg);
    return;
  }

  const messages = SUCCESS_MESSAGES[context];
  if (outcome.workflowId) {
    toast.success(messages.reprocess);
    return;
  }

  toast.success(messages.saved);
}
