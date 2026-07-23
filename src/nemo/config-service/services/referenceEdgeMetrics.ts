import { get_long_lived_meter } from '@agentstudio/observability-client-runtime';
import type { Counter, ObservableGauge, Attributes, Meter } from '@opentelemetry/api';

/**
 * Lazy meter accessor — defers the getMeter() call until first use so that
 * the real MeterProvider (set up by configure_observability_for_service) is
 * already registered when instruments are created.  Without this, module-level
 * require() chains triggered by route imports call get_long_lived_meter() before
 * configure_observability_for_service() runs, getting a no-op NoopMeter.
 */
let _meter: Meter | null = null;
function getMeter(): Meter {
  if (!_meter) _meter = get_long_lived_meter('config-service.reference-edges');
  return _meter;
}

/**
 * OTel Counter wrappers that expose a prom-client-compatible .inc() surface
 * so call sites need minimal changes.
 */
class OtelCounter {
  private _name: string;
  private _description: string;
  private _counter: Counter | null = null;

  constructor(name: string, description: string) {
    this._name = name;
    this._description = description;
  }

  private get counter(): Counter {
    if (!this._counter) {
      this._counter = getMeter().createCounter(this._name, { description: this._description });
    }
    return this._counter;
  }

  inc(labels: Attributes = {}, value = 1): void {
    this.counter.add(value, labels);
  }
}

/**
 * OTel ObservableGauge that exposes a .set() surface compatible with
 * the previous prom-client Gauge.  The observed value is stored in a
 * module-level variable and read back on each collection cycle.
 */
class OtelGauge {
  private _value = 0;
  constructor(name: string, description: string) {
    // Defer gauge creation until the meter is first used (after configure).
    // We register the callback lazily via a polling observable pattern.
    const n = name;
    const d = description;
    let _gauge: ObservableGauge | null = null;
    const self = this;
    const ensureGauge = () => {
      if (!_gauge) {
        _gauge = getMeter().createObservableGauge(n, { description: d });
        _gauge.addCallback((result) => {
          result.observe(self._value);
        });
      }
    };
    // Attempt immediate registration; if MeterProvider not ready yet,
    // it will be retried on first set() call.
    try { ensureGauge(); } catch { /* deferred */ }
    this._ensureGauge = ensureGauge;
  }
  private _ensureGauge: () => void;
  set(value: number): void {
    this._ensureGauge();
    this._value = value;
  }
}

export const referenceEdgesAppliedTotal = new OtelCounter(
  'reference_edges_applied_total',
  'Number of times applyForEntity was invoked, by source kind.',
);

export const referenceEdgesRemovedTotal = new OtelCounter(
  'reference_edges_removed_total',
  'Number of times removeForSource was invoked, by source kind.',
);

export const referenceEdgesDriftTotal = new OtelCounter(
  'reference_edge_drift_total',
  'Edges added/removed by the reconciler against the current persisted set, by source kind and direction. Steady-state target: 0.',
);

export const referenceEdgesReconcilerLastSuccessTs = new OtelGauge(
  'reference_edges_reconciler_last_success_timestamp_seconds',
  'Unix timestamp (seconds) of the most recent successful reference-edge reconciler tick.',
);

export const referenceEdgesReconcilerScannedTotal = new OtelCounter(
  'reference_edges_reconciler_scanned_total',
  'Number of source rows scanned by the reconciler, by source kind.',
);
