import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { get_logger } from './logger_handler';
import { runWithContext } from './context_store';

/**
 * Returns the active OTel span's trace_id and span_id when a valid span
 * is in context, enabling trace-log correlation in any log aggregation system.
 */
function _getActiveTraceContext(): { trace_id?: string; span_id?: string } {
  const activeSpan = trace.getActiveSpan();
  if (!activeSpan) return {};
  const ctx = activeSpan.spanContext();
  if (!ctx || ctx.traceId === '00000000000000000000000000000000') return {};
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

/**
 * Express middleware that:
 *  - Ensures every request carries an X-Request-Id header (generates one if absent).
 *  - Captures the active OTel span context synchronously at request entry (before any
 *    async hop) so trace_id/span_id are always accurate in the finish log entry.
 *  - Logs each request via the client lib's structured logger (log4js pipeline), so
 *    entries appear in both stdout and the JSONL log file with full OTel correlation.
 *  - Suppresses info-level logs for /health and /ready to reduce noise.
 *
 * This is the Node equivalent of the Python ASGITraceMiddleware.
 */
export function express_request_logging_middleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = Date.now();

  // Capture synchronously — OTel HTTP server span is active right here, before any await.
  const traceCtx = _getActiveTraceContext();

  // Propagate project_id from the gateway-injected X-Project-ID header into
  // the active SERVER span so it appears in traces and RED metric labels.
  const projectId = req.headers['x-project-id'] as string | undefined;
  if (projectId) {
    const activeSpan = trace.getActiveSpan();
    activeSpan?.setAttribute('project_id', projectId);
  }

  let requestId = req.headers['x-request-id'] as string | undefined;
  if (!requestId) {
    requestId = randomUUID();
  }
  req.headers['x-request-id'] = requestId;
  res.setHeader('X-Request-Id', requestId);

  // Run the entire request (downstream middleware + finish handler) inside the
  // async context so both getProjectId() and the http_request finish log see project_id.
  runWithContext({ project_id: projectId }, () => {
    const activeSpan = trace.getActiveSpan();

    res.on('finish', () => {
      const duration = Date.now() - start;
      const log = get_logger();
      const statusCode = res.statusCode;
      if (activeSpan) {
        activeSpan.setAttribute('http.response.status_code', String(statusCode));
        if (statusCode >= 500) {
          activeSpan.setStatus({ code: SpanStatusCode.ERROR });
        }
      }

      const fields: Record<string, unknown> = {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: duration,
        request_id: requestId,
        ...traceCtx,
        ...(projectId ? { project_id: projectId } : {}),
      };

      if (req.path === '/health' || req.path === '/ready') {
        log.debug('http_request', fields);
      } else {
        log.info('http_request', fields);
      }
    });

    next();
  });
}
