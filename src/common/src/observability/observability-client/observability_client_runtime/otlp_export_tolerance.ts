/**
 * Configure OpenTelemetry diagnostic output level for OTLP export noise.
 *
 * Default behaviour: suppress everything below ERROR so routine
 * "collector unreachable" retries don't pollute stdout, while still
 * surfacing genuine export failures.
 *
 * Set AGENT_STUDIO_KEEP_OTLP_EXPORT_LOGS=1 (or true/yes/on) to flip to
 * full DEBUG output for troubleshooting.
 *
 * Mirrors Python ``apply_otlp_unreachable_export_silencing``.
 */
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

export function applyOtlpUnreachableExportSilencing(): void {
  const raw = (process.env['AGENT_STUDIO_KEEP_OTLP_EXPORT_LOGS'] ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
    return;
  }
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);
}
