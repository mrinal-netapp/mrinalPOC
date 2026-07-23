/**
 * Unit tests for services/referenceEdgeMetrics.ts.
 *
 * The metrics are now OTel-based (Counter / ObservableGauge) rather than
 * prom-client, so there is no shared registry to query.  These tests verify
 * that every exported instrument has the expected interface and that calling
 * inc()/set() does not throw — i.e. the lazy OTel instrument creation path
 * works correctly against the default NoopMeterProvider.
 *
 * Run: node --require ts-node/register --test tests/referenceEdgeMetrics.unit.test.ts
 */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  referenceEdgesAppliedTotal,
  referenceEdgesRemovedTotal,
  referenceEdgesDriftTotal,
  referenceEdgesReconcilerLastSuccessTs,
  referenceEdgesReconcilerScannedTotal,
} from '../services/referenceEdgeMetrics';

test('all reference-edge counter exports expose an inc() method', () => {
  assert.strictEqual(typeof referenceEdgesAppliedTotal.inc, 'function');
  assert.strictEqual(typeof referenceEdgesRemovedTotal.inc, 'function');
  assert.strictEqual(typeof referenceEdgesDriftTotal.inc, 'function');
  assert.strictEqual(typeof referenceEdgesReconcilerScannedTotal.inc, 'function');
});

test('last-success gauge export exposes a set() method', () => {
  assert.strictEqual(typeof referenceEdgesReconcilerLastSuccessTs.set, 'function');
});

test('counters can be incremented with labels without throwing', () => {
  assert.doesNotThrow(() => referenceEdgesAppliedTotal.inc({ kind: 'agent' }, 2));
  assert.doesNotThrow(() => referenceEdgesRemovedTotal.inc({ kind: 'model' }, 3));
  assert.doesNotThrow(() => referenceEdgesReconcilerScannedTotal.inc({ kind: 'agent' }));
});

test('drift counter accepts both directions without throwing', () => {
  assert.doesNotThrow(() => referenceEdgesDriftTotal.inc({ kind: 'pipeline', direction: 'added' }, 5));
  assert.doesNotThrow(() => referenceEdgesDriftTotal.inc({ kind: 'pipeline', direction: 'removed' }, 1));
});

test('gauge can be set without throwing', () => {
  assert.doesNotThrow(() => referenceEdgesReconcilerLastSuccessTs.set(1700000000));
});

test('counters accept default labels (no labels / no value)', () => {
  assert.doesNotThrow(() => referenceEdgesAppliedTotal.inc());
  assert.doesNotThrow(() => referenceEdgesReconcilerScannedTotal.inc({}, 10));
});
