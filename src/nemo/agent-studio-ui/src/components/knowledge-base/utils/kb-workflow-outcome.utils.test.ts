import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { KBWorkflowOutcome } from '@/api/kb.types';

vi.mock('@/ui-lib/base-components/toast/toast', () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { toast } from '@/ui-lib/base-components/toast/toast';
import { showKBWorkflowOutcomeToast } from './kb-workflow-outcome.utils';

describe('showKBWorkflowOutcomeToast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('[tag:kb-workflow] shows warning when backend returns warning', () => {
    showKBWorkflowOutcomeToast('update', {
      warning: 'Knowledge base updated but reprocessing was skipped: dataset not ready',
      workflowSkippedReason: 'dataset_not_ready',
    });

    expect(toast.warning).toHaveBeenCalledWith(
      'Knowledge base updated but reprocessing was skipped: dataset not ready',
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('[tag:kb-workflow] shows warning from workflowError when warning is absent', () => {
    showKBWorkflowOutcomeToast('create', {
      workflowError: 'workflow engine unavailable',
    });

    expect(toast.warning).toHaveBeenCalledWith('workflow engine unavailable');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('[tag:kb-workflow] prefers warning over workflowError when both are present', () => {
    showKBWorkflowOutcomeToast('update', {
      warning: 'Knowledge base updated but reprocessing workflow failed to start',
      workflowError: 'connection refused',
    });

    expect(toast.warning).toHaveBeenCalledWith(
      'Knowledge base updated but reprocessing workflow failed to start',
    );
  });

  it('[tag:kb-workflow] shows reprocess success when workflowId is present', () => {
    showKBWorkflowOutcomeToast('update', { workflowId: 'wf-123' });

    expect(toast.success).toHaveBeenCalledWith('Knowledge base updated. Reprocessing started.');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('[tag:kb-workflow] shows plain success when no workflow fields are present', () => {
    showKBWorkflowOutcomeToast('create', {});

    expect(toast.success).toHaveBeenCalledWith('Knowledge base created successfully.');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it.each<[string, KBWorkflowOutcome, string]>([
    ['sync', { workflowId: 'wf-sync' }, 'Synchronization started.'],
    ['syncSettings', {}, 'Synchronization settings updated successfully.'],
    ['syncSettings', { workflowId: 'wf-1' }, 'Synchronization settings updated. Reprocessing started.'],
  ])('[tag:kb-workflow] context "%s" shows expected success message', (context, outcome, expected) => {
    showKBWorkflowOutcomeToast(context as 'sync' | 'syncSettings', outcome);

    expect(toast.success).toHaveBeenCalledWith(expected);
  });
});
