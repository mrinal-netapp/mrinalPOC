import fs from 'fs';
import path from 'path';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { Context } from '@opentelemetry/api';
import type { ObservabilityDefaults } from './types';

const DEFAULT_TRACE_DIR = 'Trace_Logs';
const DEFAULT_TRACE_FILENAME = 'trace.jsonl';

export const TRACE_SPAN_RECORD_TYPE = 'trace_span';

const _TRACER_NAME = 'logging.logger_handler';

const _OPENLLMETRY_SCOPE_MARKERS: ReadonlyArray<string> = [
  'traceloop.tracer',
  'instrumentation.openai',
  'instrumentation.langchain',
  'instrumentation.mcp',
  'instrumentation.crewai',
  'instrumentation.llamaindex',
  'instrumentation.chromadb',
  'instrumentation.anthropic',
  'instrumentation.bedrock',
  'instrumentation.agno',
  'instrumentation.haystack',
  'instrumentation.transformers',
  'instrumentation.openai_agents',
  'instrumentation.groq',
  'instrumentation.cohere',
  'instrumentation.mistralai',
  'instrumentation.ollama',
  'instrumentation.pinecone',
  'instrumentation.qdrant',
  'instrumentation.weaviate',
  'instrumentation.milvus',
  'instrumentation.marqo',
  'instrumentation.replicate',
  'instrumentation.sagemaker',
  'instrumentation.together',
  'instrumentation.lancedb',
  'instrumentation.vertexai',
  'instrumentation.voyageai',
  'instrumentation.watsonx',
  'instrumentation.writer',
  'instrumentation.google_generativeai',
  'instrumentation.alephalpha',
];

function _instrumentationScopeName(span: ReadableSpan): string {
  const scope = span.instrumentationScope;
  if (!scope) return '';
  return String(scope.name ?? '');
}

function _spanMatchesOpenllmetryJsonlFilter(span: ReadableSpan): boolean {
  try {
    const attrs = span.attributes ?? {};
    for (const key of Object.keys(attrs)) {
      if (key.startsWith('traceloop.') || key.startsWith('gen_ai.')) {
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  const scopeName = _instrumentationScopeName(span);
  if (!scopeName || scopeName === _TRACER_NAME) return false;
  if (scopeName === 'traceloop.tracer') return true;
  return _OPENLLMETRY_SCOPE_MARKERS.some((m) => scopeName.includes(m));
}

function _readableSpanToJsonObject(span: ReadableSpan): Record<string, unknown> {
  const sc =
    typeof (span as unknown as { spanContext: () => unknown }).spanContext === 'function'
      ? (span as unknown as { spanContext: () => { traceId: string; spanId: string; traceFlags: number } }).spanContext()
      : (span as unknown as { spanContext: { traceId: string; spanId: string; traceFlags: number } }).spanContext;
  const psc = span.parentSpanContext;
  const scope = span.instrumentationScope;
  return {
    name: span.name,
    kind: span.kind,
    traceId: sc.traceId,
    spanId: sc.spanId,
    traceFlags: sc.traceFlags,
    parentSpanId: psc ? psc.spanId : undefined,
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    status: span.status,
    attributes: span.attributes,
    events: span.events,
    links: span.links,
    instrumentationScope: scope
      ? { name: scope.name, version: scope.version, schemaUrl: scope.schemaUrl }
      : undefined,
  };
}

export function resolveTraceOutputPath(traceFilePath: string | null | undefined): string | null {
  if (traceFilePath == null) return null;
  const raw = String(traceFilePath).trim();
  if (!raw) return null;
  const p = path.resolve(raw);
  if (fs.existsSync(p)) {
    if (fs.statSync(p).isFile()) return p;
    if (fs.statSync(p).isDirectory()) return path.join(p, DEFAULT_TRACE_FILENAME);
  }
  if (path.extname(p)) return p;
  return path.join(p, DEFAULT_TRACE_FILENAME);
}

function tracePushActive(
  config: Pick<ObservabilityDefaults, 'otlp_traces_endpoint' | 'enable_openllmetry'>,
  resolveTraceEndpointFn: (ep: string | null) => string | null,
): boolean {
  return (
    Boolean(resolveTraceEndpointFn(config.otlp_traces_endpoint)) ||
    Boolean(config.enable_openllmetry)
  );
}

export function effectiveTraceJsonlPath(
  config: Pick<
    ObservabilityDefaults,
    | 'write_spans_to_jsonl_file'
    | 'trace_file_path'
    | 'otlp_traces_endpoint'
    | 'enable_openllmetry'
    | 'log_file_path'
  >,
  resolveTraceEndpointFn: (ep: string | null) => string | null,
  resolveLogOutputPathFn: (lp: string | null) => string,
): string | null {
  if (!config.write_spans_to_jsonl_file) return null;
  if (config.trace_file_path == null) {
    return path.resolve(DEFAULT_TRACE_DIR, DEFAULT_TRACE_FILENAME);
  }
  const explicit = resolveTraceOutputPath(config.trace_file_path);
  if (explicit != null) return explicit;
  if (tracePushActive(config, resolveTraceEndpointFn)) {
    const appLog = resolveLogOutputPathFn(config.log_file_path);
    return path.join(path.dirname(appLog), DEFAULT_TRACE_FILENAME);
  }
  return null;
}

export class FileJsonlSpanProcessor implements SpanProcessor {
  private readonly _path: string;
  private readonly _encoding: BufferEncoding;
  private readonly _traceJsonlFilter: string;

  constructor(absPath: string, encoding?: string, traceJsonlFilter?: string) {
    this._path = absPath;
    this._encoding = (encoding ?? 'utf-8') as BufferEncoding;
    this._traceJsonlFilter = traceJsonlFilter ?? 'openllmetry';
  }

  onStart(): void {
    // SpanProcessor contract: JSONL is written in onEnd only.
  }

  onEnd(span: ReadableSpan): void {
    const ctx =
      typeof (span as unknown as { spanContext: () => { traceId: string } }).spanContext === 'function'
        ? (span as unknown as { spanContext: () => { traceId: string } }).spanContext()
        : (span as unknown as { spanContext: { traceId: string } }).spanContext;
    if (!ctx || !ctx.traceId) return;
    if (
      this._traceJsonlFilter === 'openllmetry' &&
      !_spanMatchesOpenllmetryJsonlFilter(span)
    ) {
      return;
    }
    let line: string;
    try {
      line = JSON.stringify(_readableSpanToJsonObject(span)) + '\n';
    } catch {
      return;
    }
    try {
      fs.appendFileSync(this._path, line, { encoding: this._encoding });
    } catch {
      /* ignore */
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

export class CompositeSpanProcessor implements SpanProcessor {
  private readonly _processors: SpanProcessor[];

  constructor(processors: SpanProcessor[]) {
    this._processors = processors;
  }

  onStart(span: Parameters<SpanProcessor['onStart']>[0], context: Context): void {
    for (const p of this._processors) {
      if (p.onStart) p.onStart(span, context);
    }
  }

  onEnd(span: ReadableSpan): void {
    for (const p of this._processors) {
      p.onEnd(span);
    }
  }

  shutdown(): Promise<void> {
    return Promise.all(
      this._processors.map((p) => (p.shutdown ? p.shutdown() : Promise.resolve())),
    ).then(() => undefined);
  }

  forceFlush(): Promise<void> {
    return Promise.all(
      this._processors.map((p) => (p.forceFlush ? p.forceFlush() : Promise.resolve())),
    ).then(() => undefined);
  }
}

export { DEFAULT_TRACE_DIR, DEFAULT_TRACE_FILENAME };
