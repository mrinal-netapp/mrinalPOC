import { resolveTemplateRuntime } from '../../../../src/lib/evaluation/lib/resolve-template';
import type {
  ResolvedWorkflowSnapshot,
  EvaluationTemplate,
  MinimalProvenance,
} from '../../../../src/lib/evaluation/lib/template-types';

function fixtureProvenance(): MinimalProvenance {
  return {
    triggeredAt: '2026-05-28T12:00:00Z',
    agentRef: { projectId: 'proj-1', agentTeam: 'team-1', agentId: 'agent-1' },
    models: ['gpt-4o'],
    rubricIds: ['rubric-correctness', 'rubric-safety'],
  };
}

function fixtureTemplate(
  overrides: Partial<EvaluationTemplate> = {},
): EvaluationTemplate {
  return {
    templateId: 'tpl-1',
    projectId: 'proj-1',
    evalName: 'rag-quality',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-28T00:00:00Z',
    target: 'agent_version',
    agent: { agentTeam: 'team-1', agentId: 'agent-1' },
    models: ['gpt-4o'],
    evaluationScope: 'full_agent_execution',
    suite: 'rag',
    evaluators: {
      strategy: 'deterministic',
      rubricPreset: 'none',
      enabledRubric: [],
      judgeEvalMode: 'pointwise',
      judgeSamplingMode: 'all',
      judgeStratifiedSlices: false,
      judgeGateWhenSampled: 'informational',
      goldenAvailable: true,
    },
    thresholds: {
      gates: [{ id: 'rag.groundedness', level: 'warning', threshold: 0.8 }],
      coverageMinPct: 90,
      infraFailureMaxPct: 10,
      safetyP0Threshold: 0,
      minCompletedCases: 1,
    },
    cases: {
      schemaVersion: 'golden_test_v1',
      sample: { mode: 'all' },
    },
    runMode: 'single',
    concurrency: 4,
    ...overrides,
  };
}

function fixtureWorkflowInput(
  templateOverrides: Partial<EvaluationTemplate> = {},
  inputOverrides: Partial<ResolvedWorkflowSnapshot> = {},
): ResolvedWorkflowSnapshot {
  return {
    runId: 'run-1',
    templateSnapshot: fixtureTemplate(templateOverrides),
    provenance: fixtureProvenance(),
    ...inputOverrides,
  };
}

describe('resolveTemplateRuntime', () => {
  describe('happy path', () => {
    it('maps template scalars 1:1 into EvaluationJobInput', () => {
      const result = resolveTemplateRuntime(fixtureWorkflowInput());
      expect(result.runId).toBe('run-1');
      expect(result.evalName).toBe('rag-quality');
      expect(result.projectId).toBe('proj-1');
      expect(result.target).toBe('agent_version');
      expect(result.evaluationScope).toBe('full_agent_execution');
      expect(result.suite).toBe('rag');
      expect(result.runMode).toBe('single');
      expect(result.models).toEqual(['gpt-4o']);
    });

    it('builds the testCases pointer from template.cases', () => {
      const result = resolveTemplateRuntime(fixtureWorkflowInput());
      expect(result.testCases.schemaVersion).toBe('golden_test_v1');
      expect(result.testCases.sample).toEqual({ mode: 'all' });
      // No datasetId/datasetVersion any more — testcases live at
      // `projects/{projectId}/evaluations/{evalId}/testcases/` and the
      // path is computed from `evalId` alone.
      expect(result.testCases).not.toHaveProperty('datasetId');
      expect(result.testCases).not.toHaveProperty('datasetVersion');
    });

    it('forwards the template-pinned filename through testCases', () => {
      const result = resolveTemplateRuntime(
        fixtureWorkflowInput({
          cases: {
            schemaVersion: 'golden_test_v1',
            filename: 'rag-eval-v3.jsonl',
            sample: { mode: 'all' },
          },
        }),
      );
      expect(result.testCases.filename).toBe('rag-eval-v3.jsonl');
    });

    it('omits filename when the template does not pin it', () => {
      const result = resolveTemplateRuntime(fixtureWorkflowInput());
      expect(result.testCases.filename).toBeUndefined();
    });

    it('passes evaluators (shallow-copied with enabledRubric defaulted) and thresholds through', () => {
      const tpl = fixtureTemplate();
      const result = resolveTemplateRuntime(
        fixtureWorkflowInput({}, { templateSnapshot: tpl }),
      );
      // evaluators is shallow-copied so we can default enabledRubric to []
      // when the template omits it (config-service does not require the
      // field on the template row).
      expect(result.evaluators).toEqual(tpl.evaluators);
      // thresholds is still passed through by reference — no defaulting.
      expect(result.thresholds).toBe(tpl.thresholds);
    });
  });

  describe('overrides', () => {
    it('honours runtime concurrency over template concurrency', () => {
      const result = resolveTemplateRuntime(
        fixtureWorkflowInput({ concurrency: 4 }, { overrides: { concurrency: 16 } }),
      );
      expect(result.concurrency).toBe(16);
    });

    it('falls back to template concurrency when no override', () => {
      const result = resolveTemplateRuntime(fixtureWorkflowInput({ concurrency: 8 }));
      expect(result.concurrency).toBe(8);
    });

    it('returns undefined concurrency when neither template nor override sets it', () => {
      const result = resolveTemplateRuntime(
        fixtureWorkflowInput({ concurrency: undefined }),
      );
      expect(result.concurrency).toBeUndefined();
    });

    it('honours runtime sampleOverride over template.cases.sample', () => {
      const result = resolveTemplateRuntime(
        fixtureWorkflowInput(
          {
            cases: {
              schemaVersion: 'golden_test_v1',
              sample: { mode: 'all' },
            },
          },
          { overrides: { sampleOverride: { mode: 'fraction', fraction: 0.25 } } },
        ),
      );
      expect(result.testCases.sample).toEqual({ mode: 'fraction', fraction: 0.25 });
    });

    it('defaults sample to { mode: "all" } when template has no sample and no override', () => {
      const tpl = fixtureTemplate({
        cases: { schemaVersion: 'golden_test_v1' },
      });
      const result = resolveTemplateRuntime(
        fixtureWorkflowInput({}, { templateSnapshot: tpl }),
      );
      expect(result.testCases.sample).toEqual({ mode: 'all' });
    });
  });

  describe('run modes', () => {
    it('maps regression.baselineRunId to legacy regression.baselineJobId', () => {
      const result = resolveTemplateRuntime(
        fixtureWorkflowInput({
          runMode: 'regression',
          regression: { baselineRunId: 'baseline-7' },
        }),
      );
      expect(result.regression).toEqual({ baselineJobId: 'baseline-7' });
    });

    it('passes ab block through verbatim', () => {
      const ab = {
        variants: [
          { variantId: 'A', label: 'ctrl', overrides: {} },
          { variantId: 'B', label: 'cand', overrides: { temperature: 0.7 } },
        ],
        comparabilityChecks: ['model_family'],
      };
      const result = resolveTemplateRuntime(
        fixtureWorkflowInput({ runMode: 'ab_compare', ab }),
      );
      expect(result.ab).toBe(ab);
    });

    it('maps repeats block, preserving count and seeds', () => {
      const result = resolveTemplateRuntime(
        fixtureWorkflowInput({ repeats: { count: 3, seeds: [1, 2, 3] } }),
      );
      expect(result.repeats).toEqual({ count: 3, seeds: [1, 2, 3] });
    });

    it('returns undefined for absent mode-specific blocks', () => {
      const result = resolveTemplateRuntime(fixtureWorkflowInput());
      expect(result.regression).toBeUndefined();
      expect(result.ab).toBeUndefined();
      expect(result.repeats).toBeUndefined();
    });
  });

  describe('provenance widening', () => {
    it('echoes rubricIds from MinimalProvenance into the legacy envelope', () => {
      const result = resolveTemplateRuntime(fixtureWorkflowInput());
      expect(result.provenance.rubricIds).toEqual([
        'rubric-correctness',
        'rubric-safety',
      ]);
    });

    it('fills version-hash fields with empty placeholders (§17 deferred)', () => {
      const result = resolveTemplateRuntime(fixtureWorkflowInput());
      expect(result.provenance.agentVersionHash).toBe('');
      expect(result.provenance.retrievalIndexVersion).toBe('');
      expect(result.provenance.toolRegistryVersion).toBe('');
      expect(result.provenance.generatorModelVersion).toBe('');
      expect(result.provenance.rubricPrompts).toEqual([]);
      // envelopeHash is now content-derived (deterministic FNV-1a over
      // the canonical envelope), not the old '' that made the
      // comparability check a no-op. Format: 8 hex chars.
      expect(result.provenance.envelopeHash).toMatch(/^[0-9a-f]{8}$/);
    });

    it('envelopeHash is deterministic — same inputs hash to the same value across calls', () => {
      const a = resolveTemplateRuntime(fixtureWorkflowInput());
      const b = resolveTemplateRuntime(fixtureWorkflowInput());
      expect(a.provenance.envelopeHash).toBe(b.provenance.envelopeHash);
    });

    it('envelopeHash differs when rubricIds differ', () => {
      const f1 = fixtureWorkflowInput();
      const f2 = fixtureWorkflowInput();
      f2.provenance.rubricIds = ['rubric-correctness']; // different from f1
      const a = resolveTemplateRuntime(f1);
      const b = resolveTemplateRuntime(f2);
      expect(a.provenance.envelopeHash).not.toBe(b.provenance.envelopeHash);
    });

    it('copies rubricIds (mutations on result must not affect the input)', () => {
      const input = fixtureWorkflowInput();
      const result = resolveTemplateRuntime(input);
      result.provenance.rubricIds.push('mutated');
      expect(input.provenance.rubricIds).toEqual([
        'rubric-correctness',
        'rubric-safety',
      ]);
    });
  });

  describe('determinism', () => {
    it('two calls with the same input produce structurally equal outputs', () => {
      const input = fixtureWorkflowInput();
      const a = resolveTemplateRuntime(input);
      const b = resolveTemplateRuntime(input);
      expect(a).toEqual(b);
    });
  });

  describe('null-safe fallbacks', () => {
    it('treats template.cases=null as missing and still resolves cleanly', () => {
      // Some config-service templates predate the cases attachment route, so
      // `cases` can be null on the row. resolveTemplateRuntime must default
      // schemaVersion + sample without throwing.
      const tpl = fixtureTemplate({
        cases: null as unknown as EvaluationTemplate['cases'],
      });
      const result = resolveTemplateRuntime(
        fixtureWorkflowInput({}, { templateSnapshot: tpl }),
      );
      expect(result.testCases.schemaVersion).toBe('golden_test_v1');
      expect(result.testCases.sample).toEqual({ mode: 'all' });
      expect(result.testCases.filter).toBeUndefined();
    });

    it('passes through cases.filter when set', () => {
      const tpl = fixtureTemplate({
        cases: {
          schemaVersion: 'golden_test_v1',
          sample: { mode: 'all' },
          filter: { category: ['rag'], includeLabelSuspect: false },
        },
      });
      const result = resolveTemplateRuntime(
        fixtureWorkflowInput({}, { templateSnapshot: tpl }),
      );
      expect(result.testCases.filter).toEqual({
        category: ['rag'],
        includeLabelSuspect: false,
      });
    });

    it('defaults evaluators.enabledRubric to [] when the template omits it', () => {
      const tpl = fixtureTemplate({
        evaluators: {
          ...fixtureTemplate().evaluators,
          enabledRubric: undefined as unknown as string[],
        },
      });
      const result = resolveTemplateRuntime(
        fixtureWorkflowInput({}, { templateSnapshot: tpl }),
      );
      expect(result.evaluators.enabledRubric).toEqual([]);
    });

    it('falls back to permissive thresholds when the template has none', () => {
      const tpl = fixtureTemplate({
        thresholds: undefined as unknown as EvaluationTemplate['thresholds'],
      });
      const result = resolveTemplateRuntime(
        fixtureWorkflowInput({}, { templateSnapshot: tpl }),
      );
      expect(result.thresholds).toMatchObject({
        gates: [],
        coverageMinPct: 0,
        infraFailureMaxPct: 100,
        safetyP0Threshold: 0,
      });
    });
  });
});
