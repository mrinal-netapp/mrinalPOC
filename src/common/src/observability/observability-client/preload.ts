/**
 * OTel preload script — must be required BEFORE any other module via NODE_OPTIONS.
 *
 * Usage: NODE_OPTIONS='--require /path/to/preload.js' node dist/index.js
 *
 * Uses registerInstrumentations() — NOT NodeSDK.start() — so that auto-instrumentations
 * patch http/https/express early without claiming the global TracerProvider slot.
 * This keeps the slot free for configure_observability_logging() (called later by
 * initLogger) to register its own NodeTracerProvider with the full set of span
 * processors (FileJsonlSpanProcessor, RedMetricsSpanProcessor, OTLPBatchProcessor).
 *
 * If we called NodeSDK.start() here, OTel API would refuse the second registration
 * in configure_observability_logging with "Attempted duplicate registration of API: trace",
 * leaving no FileJsonl or RED metric processors attached to any provider.
 */
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

registerInstrumentations({
  instrumentations: [
    getNodeAutoInstrumentations({
      // Suppress non-essential instrumentations to keep startup lean.
      // HTTP and Express are the critical ones for trace context propagation.
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
    }),
  ],
});
