// Audit event (spec §5.7).

export type AuditAction =
  | 'evaluation.created'
  | 'evaluation.preflight.run'
  | 'evaluation.started'
  | 'evaluation.stop.requested'
  | 'evaluation.stopped'
  | 'evaluation.completed'
  | 'evaluation.failed'
  | 'evaluation.override.accepted'
  | 'evaluation.tradeoff.recorded'
  | 'evaluation.baseline.saved'
  | 'case.promoted_to_regression';

export interface AuditEvent {
  id: string;
  ts: string;
  actor: string;
  /** Set on per-run lifecycle events (preflight / started / completed / etc.). */
  runId?: string;
  /**
   * Set on template-scoped events (template created / edited / archived). Either
   * `runId` or `templateId` is set on each event; never both.
   */
  templateId?: string;
  action: AuditAction;
  details?: Record<string, unknown>;
}
