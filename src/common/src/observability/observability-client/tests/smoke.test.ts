import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ObservabilityLoggingConfig,
  configure_observability_logging,
  get_logger,
  log_event,
  with_otel_span,
  shutdown_observability,
} from '../observability_client_runtime/logger_handler';
import {
  normalizeOtlpHttpTracesEndpoint,
  normalizeOtlpHttpMetricsEndpoint,
} from '../observability_client_runtime/otlp_endpoint_utils';
import { normalizeLevelName } from '../enums/log-levels';

test('basic log event writes JSON line via log4js', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alis-test-'));
  const logFile = path.join(tmpDir, 'app.jsonl');

  const config = new ObservabilityLoggingConfig({
    log_file_path: logFile,
    write_spans_to_jsonl_file: false,
    otlp_traces_endpoint: null,
    metrics_otlp_endpoint: null,
    prometheus_metrics_port: null,
    enable_red_metrics: false,
    enable_auto_instrumentation: false,
    min_log_level: 'debug',
  });
  configure_observability_logging({ config });

  with_otel_span('test-span', () => {
    log_event('info', 'hello from test', { key: 'value' });
  });

  await new Promise<void>((resolve) => setTimeout(resolve, 200));
  await shutdown_observability();

  const lines = fs
    .readFileSync(logFile, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '');
  assert.ok(lines.length >= 1, `Expected at least 1 log line, got ${lines.length}`);
  const rec = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(rec['event'], 'hello from test', `event mismatch: ${JSON.stringify(rec)}`);
  assert.ok('trace_id' in rec, `missing trace_id: ${JSON.stringify(rec)}`);
  assert.equal(rec['level'], 'info');
  assert.ok(rec['timestamp'], 'missing timestamp');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('NormalizeOTLPEndpoints', () => {
  assert.equal(
    normalizeOtlpHttpTracesEndpoint('http://localhost:4318'),
    'http://localhost:4318/v1/traces',
  );
  assert.equal(
    normalizeOtlpHttpMetricsEndpoint('http://localhost:4318/v1/metrics'),
    'http://localhost:4318/v1/metrics',
  );
});

test('LogLevel normalization', () => {
  assert.equal(normalizeLevelName('WARN'), 'warning');
  assert.equal(normalizeLevelName('fatal'), 'critical');
  assert.equal(normalizeLevelName('INFO'), 'info');
});

// Smoke check: get_logger returns a usable logger
test('get_logger returns a usable logger after configure', () => {
  const logger = get_logger();
  assert.ok(typeof logger.info === 'function', 'logger.info must be a function');
  assert.ok(typeof logger.error === 'function', 'logger.error must be a function');
});
