import { useCallback, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { IconX } from '@tabler/icons-react';

import { useAppSelector } from '@/store';
import { projectContextSelector } from '@/store/selectors/project-context.selector';
import type { EvalScoringStrategy, EvalTestCaseSource, EvalDatasetColumnMapping, EvaluationTemplate } from '@/routes/pages/evaluations/api/eval.types';
import { useCreateEvaluationMutation, useUpdateEvaluationMutation } from '@/routes/pages/evaluations/api/eval-api.slice';
import { fromTemplate, toBackendMetricIds, toCreateTemplateRequest, toUpdateDelta, slugifyEvalName, casesSchemaVersionFor, canonicalCasesFilename } from '@/routes/pages/evaluations/api/eval-mappers';
import { useLazyGetProjectQuery } from '@/api/project-api.slice';
import { parseProjectStorageRoot } from '@/api/project-storage';
import { putObject, getObjectText } from '@/api/s3-upload';
import { Button } from '@/ui-lib/base-components/button/button';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import { Card } from '@/ui-lib/base-components/card/card';
import { CardContent } from '@/ui-lib/base-components/card/card.content';
import { CardBlock } from '@/ui-lib/base-components/card/card.block';
import { toast } from '@/ui-lib/base-components/toast/toast';
import { extractApiErrorMessage } from '@/utils/api-error.utils';

import { evalPaths } from '@/routes/pages/evaluations/evaluations.consts';
import { EvalDetailsSection } from './eval-details-section';
import { EvalAgentSection } from './eval-agent-section';
// Scheduled runs disabled for this phase - re-enable when needed
// import { EvalScheduleSection } from './eval-schedule-section';
import { EvalScoringSection } from './eval-scoring-section';
import type { DeterministicConfigSavePayload } from '@/components/evaluations/configure-dialogs/deterministic-config-dialog';

import { EVAL_NAME_PATTERN } from './eval-form.consts';
import '../../../data-management/dataset/create-edit/form/dataset-form.scss';

type LabelItem = { key: string; value: string; label: string };

// Keys must match JUDGE_DIMENSIONS ids in judge-config-dialog.tsx (underscore_case)
const ALL_JUDGE_DIMENSION_IDS = [
  'helpfulness', 'correctness', 'completeness', 'coherence',
  'following_instructions', 'professional_style_tone', 'faithfulness_groundedness',
  'safety_harmlessness', 'refusal_quality',
];

// Keys must match METRIC_CATALOG ids in deterministic-config-dialog.tsx
const DEFAULT_DETERMINISTIC_IDS = [
  'rag_quality', 'correctness', 'performance', 'token_usage',
];

/**
 * Build a unique clone name in the format:
 *   Clone from {originalName} {YYYYMMDD-HHmm}
 * The UTC timestamp suffix guarantees uniqueness even when the same source
 * is cloned multiple times in quick succession.
 */
function buildCloneName(originalName: string): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  return `Clone from ${originalName} ${stamp}`;
}

/** Build the label option list from the evaluation's already-saved labels (edit mode). */
function buildInitialLabelItems(extraLabels: string[] = []): LabelItem[] {
  const items: LabelItem[] = [];
  for (const label of extraLabels) {
    const trimmed = label.trim().toLowerCase();
    if (trimmed && !items.some((i) => i.value === trimmed)) {
      items.push({ key: trimmed, value: trimmed, label: trimmed });
    }
  }
  return items;
}

type EvalFormProps = {
  isEdit?: boolean;
  /** Pre-filled data for edit mode from useGetEvaluationQuery. Undefined on create. */
  initialData?: EvaluationTemplate;
  /**
   * Source template to clone from. When set, the form opens in create mode
   * pre-filled with all settings from this template (name gets a
   * "Clone from … {timestamp}" prefix). Mutually exclusive with isEdit/initialData.
   */
  cloneSource?: EvaluationTemplate;
};

function EvalForm({ isEdit = false, initialData, cloneSource }: EvalFormProps): ReactElement {
  const navigate = useNavigate();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const [createEvaluation, { isLoading: isCreating }] = useCreateEvaluationMutation();
  const [updateEvaluation, { isLoading: isUpdating }] = useUpdateEvaluationMutation();
  const isSubmitting = isCreating || isUpdating;

  // Pre-fill from EvaluationTemplate via the fromTemplate mapper (eval-mappers.ts).
  // Edit mode: use initialData as-is. Clone mode: use cloneSource with a generated name.
  // Create mode: use defaults.
  const prefill = initialData
    ? fromTemplate(initialData)
    : cloneSource
      ? { ...fromTemplate(cloneSource), name: buildCloneName(cloneSource.evalName) }
      : {};
  const initialLabelItems = buildInitialLabelItems(prefill.selectedLabels);
  const initialSelectedLabels = initialLabelItems.map(({ value }) => value);

  // Form draft state — local to this component, not in Redux.
  // Per state management guide: form values belong in useState / @tanstack/react-form.
  const [name, setName] = useState(prefill.name ?? '');
  const [description, setDescription] = useState(prefill.description ?? '');
  const [labelItems, setLabelItems] = useState<LabelItem[]>(() =>
    initialLabelItems,
  );
  const [selectedLabels, setSelectedLabels] = useState<string[]>(
    initialSelectedLabels,
  );
  const [agentVersionKey, setAgentVersionKey] = useState(prefill.agentVersionKey ?? '');
  const [strategy, setStrategy] = useState<EvalScoringStrategy>(
    prefill.strategy ?? 'both',
  );
  // Scheduled runs disabled for this phase - re-enable setScheduleEnabled when needed
  const [scheduleEnabled] = useState(prefill.scheduleEnabled ?? false);
  const [judgeModel, setJudgeModel] = useState(prefill.judgeModel ?? '');
  const [judgeDimensionIds, setJudgeDimensionIds] = useState<string[]>(
    prefill.judgeDimensionIds ?? [...ALL_JUDGE_DIMENSION_IDS],
  );
  const [deterministicMetricIds, setDeterministicMetricIds] = useState<string[]>(
    prefill.deterministicMetricIds ?? [...DEFAULT_DETERMINISTIC_IDS],
  );
  const testCaseSource: EvalTestCaseSource = 'upload';
  const [isJudgeConfigured, setIsJudgeConfigured] = useState(
    (isEdit && !!initialData) || !!cloneSource,
  );
  // Tracks whether the user has explicitly opened and saved the deterministic config.
  // Required before submitting — the card shows a validation error if not done.
  const [isDeterministicConfigured, setIsDeterministicConfigured] = useState(
    (isEdit && !!initialData) || !!cloneSource,
  );
  const [datasetColumnMapping, setDatasetColumnMapping] = useState<EvalDatasetColumnMapping>(
    { id: '', query: '', expected: undefined },
  );
  const [uploadedFileName, setUploadedFileName] = useState('');
  // Raw File chosen in the deterministic dialog. Held outside the form-state
  // payload because it isn't part of the API contract — eval-form PUTs the
  // bytes to S3 at submit time and the template stores only ``cases.filename``.
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [fetchProject] = useLazyGetProjectQuery();
  // Scheduled runs disabled for this phase - re-enable when needed
  // Schedule builder state — local UI state; mapped to API payload in eval-mappers.ts.
  // const [scheduleMode, setScheduleMode] = useState<'builder' | 'cron'>('builder');
  // const [scheduleCadence, setScheduleCadence] = useState<'hourly' | 'daily' | 'weekly' | 'monthly'>('daily');
  // const [scheduleHourUtc, setScheduleHourUtc] = useState(10);
  // const [scheduleMinuteUtc, setScheduleMinuteUtc] = useState(0);
  // const [scheduleCron, setScheduleCron] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const editTemplateId = initialData?.templateId; // EvaluationTemplate has templateId
  const navigateBack = useCallback(() => {
    if (isEdit && editTemplateId) {
      // Return to the detail page of this specific evaluation on cancel/close.
      navigate(evalPaths.detail(editTemplateId));
    } else {
      navigate(evalPaths.root);
    }
  }, [isEdit, editTemplateId, navigate]);

  // State is guaranteed fresh because:
  // - EvalCreatePage uses key={location.pathname}
  // - EvalEditPage uses key={templateId}
  // A per-key component instance already means stale values can't bleed across navigations,
  // so no cleanup useEffect is needed (and it would break StrictMode double-mount pre-fill).

  // The SelectDropdown's "add new" affordance only fires this with a trimmed,
  // non-empty value that isn't already in labelItems, so no extra guards needed.
  const handleAddLabel = useCallback((value: string) => {
    const normalized = value.trim().toLowerCase();
    setLabelItems((prev) => [...prev, { key: normalized, value: normalized, label: normalized }]);
  }, []);

  const handleJudgeConfigSave = useCallback((model: string, dimensionIds: string[]) => {
    setJudgeModel(model);
    setJudgeDimensionIds(dimensionIds);
    setIsJudgeConfigured(true);
  }, []);

  const handleDeterministicConfigSave = useCallback((payload: DeterministicConfigSavePayload) => {
    setDeterministicMetricIds(payload.metricIds);
    setDatasetColumnMapping(payload.datasetColumnMapping);
    setUploadedFileName(payload.uploadedFileName);
    setUploadedFile(payload.uploadedFile);
    setIsDeterministicConfigured(true);
  }, []);

  const handleSubmit = useCallback(async () => {
    setSubmitted(true);
    const isJudgeEnabled = strategy === 'llm_judge' || strategy === 'both';
    const isDeterministicEnabled = strategy === 'deterministic' || strategy === 'both';
    const hasEnabledDeterministicMetrics = toBackendMetricIds(deterministicMetricIds).length > 0;
    if (!projectId) {
      toast.error('Select a project before saving the evaluation.');
      return;
    }

    const trimmedName = name.trim();
    const hasValidName = trimmedName.length > 0 && EVAL_NAME_PATTERN.test(trimmedName);
    const hasCasesFile = testCaseSource === 'upload' && (
      !!uploadedFile ||
      !!(isEdit && initialData?.cases?.filename) ||
      !!cloneSource?.cases?.filename
    );

    if (
      !hasValidName ||
      !agentVersionKey ||
      !isDeterministicConfigured ||
      !hasCasesFile ||
      (isDeterministicEnabled && !hasEnabledDeterministicMetrics) ||
      (isJudgeEnabled && (!isJudgeConfigured || !judgeModel))
    ) {
      if (isDeterministicEnabled && isDeterministicConfigured && !hasEnabledDeterministicMetrics) {
        toast.error('Select at least one deterministic metric that is currently available.');
      } else if (!hasCasesFile) {
        toast.error('Upload test cases before saving.');
      }
      return;
    }

    // Upload the test-cases file directly to S3 (path-style via the gateway
    // proxy) BEFORE creating/updating the template so the persisted
    // ``cases.filename`` only ever points at an object that exists. The
    // eval-worker reads from
    // ``projects/{projectId}/evaluations/{slug(evalName)}/testcases/{filename}``
    // and selects the parser by extension (.csv → flat, otherwise golden JSONL).
    let casesFilename: string | undefined;
    if (testCaseSource === 'upload' && uploadedFile) {
      try {
        const project = await fetchProject(projectId).unwrap();
        const root = parseProjectStorageRoot(project?.home_dir);
        if (!root?.bucketName) {
          toast.error('Could not determine project storage. Check project settings and try again.');
          return;
        }
        const evalId = slugifyEvalName(name);
        // Canonical filename — drop the user's original name and always
        // write ``cases.csv`` / ``cases.jsonl``. Keeps the S3 key
        // predictable (the worker also defaults to ``cases.jsonl`` when
        // ``cases.filename`` is unset) and stops one upload from
        // shadowing a previous one with a different name.
        const targetFilename = canonicalCasesFilename(uploadedFile.name);
        const key = root.pathPrefix
          ? `${root.pathPrefix}/evaluations/${evalId}/testcases/${targetFilename}`
          : `evaluations/${evalId}/testcases/${targetFilename}`;
        await putObject(root.bucketName, key, uploadedFile);
        casesFilename = targetFilename;
      } catch (err) {
        console.error('[EvalForm] test-case upload error:', err);
        toast.error('Failed to upload test cases. The evaluation was not saved.');
        return;
      }
    }

    // Clone mode — no new file uploaded but the source template had test cases.
    // Copy the original S3 file to the new eval's storage path so the eval-worker
    // can find it at:  evaluations/{slug(newName)}/testcases/{filename}
    // If the copy fails (e.g. S3 proxy warming up in local dev), the clone is still
    // saved — a warning toast tells the user to upload test cases manually.
    let testCaseCopyWarning = false;
    if (!uploadedFile && cloneSource?.cases?.filename) {
      try {
        const project = await fetchProject(projectId).unwrap();
        const root = parseProjectStorageRoot(project?.home_dir);
        if (root?.bucketName) {
          const srcSlug = slugifyEvalName(cloneSource.evalName);
          const dstSlug = slugifyEvalName(name);
          const filename = cloneSource.cases.filename;
          const prefix = root.pathPrefix ?? '';
          const srcKey = prefix
            ? `${prefix}/evaluations/${srcSlug}/testcases/${filename}`
            : `evaluations/${srcSlug}/testcases/${filename}`;
          const dstKey = prefix
            ? `${prefix}/evaluations/${dstSlug}/testcases/${filename}`
            : `evaluations/${dstSlug}/testcases/${filename}`;

          const content = await getObjectText(root.bucketName, srcKey);
          if (content !== null) {
            const mime = filename.endsWith('.csv') ? 'text/csv' : 'application/json';
            await putObject(root.bucketName, dstKey, new Blob([content], { type: mime }));
            casesFilename = filename;
          }
        }
      } catch (err) {
        console.error('[EvalForm] test-case copy error (non-blocking):', err);
        testCaseCopyWarning = true;
        // casesFilename stays undefined — template is saved without a cases pointer.
        // The user can edit the clone later and upload the test cases manually.
      }
    }

    try {
      if (isEdit && editTemplateId) {
        // PATCH — only send changed fields (delta).
        // TODO: build a proper delta against the original values once the real
        // Build delta via eval-mappers.ts (all 8 API gaps handled there).
        const formState = {
          name, description, selectedLabels, agentVersionKey, strategy,
          judgeModel, judgeDimensionIds, deterministicMetricIds,
          testCaseSource, datasetColumnMapping, uploadedFileName, scheduleEnabled,
          casesFilename,
          casesSchemaVersion: casesFilename ? casesSchemaVersionFor(casesFilename) : undefined,
        };
        const delta = toUpdateDelta(formState, initialData!);
        await updateEvaluation({ projectId, templateId: editTemplateId, body: delta }).unwrap();
        toast.success('Evaluation updated successfully.');
        navigate(evalPaths.detail(editTemplateId));
      } else {
        // Build full create payload via eval-mappers.ts.
        const formState = {
          name, description, selectedLabels, agentVersionKey, strategy,
          judgeModel, judgeDimensionIds, deterministicMetricIds,
          testCaseSource, datasetColumnMapping, uploadedFileName, scheduleEnabled,
          casesFilename,
          casesSchemaVersion: casesFilename ? casesSchemaVersionFor(casesFilename) : undefined,
        };
        const created = await createEvaluation({ projectId, body: toCreateTemplateRequest(formState) }).unwrap();
        if (cloneSource) {
          if (testCaseCopyWarning) {
            toast.success(`"${name.trim()}" cloned successfully. Test cases could not be copied — please upload them via Edit.`);
          } else {
            toast.success(`"${name.trim()}" cloned successfully.`);
          }
        } else {
          toast.success('Evaluation created successfully.');
        }
        navigate(evalPaths.detail(created.templateId));
      }
    } catch (err) {
      console.error('[EvalForm] submit error:', err);
      const fallback = isEdit ? 'Failed to update evaluation.' : cloneSource ? 'Failed to clone evaluation.' : 'Failed to create evaluation.';
      const message =
        err instanceof Error && err.message.trim()
          ? err.message.trim()
          : extractApiErrorMessage(err, fallback);
      toast.error(message);
    }
  }, [
    isEdit, editTemplateId, initialData, cloneSource, projectId,
    name, agentVersionKey, description, selectedLabels, strategy,
    judgeModel, judgeDimensionIds, deterministicMetricIds,
    testCaseSource, datasetColumnMapping, uploadedFileName, uploadedFile, scheduleEnabled,
    isDeterministicConfigured, isJudgeConfigured, createEvaluation, updateEvaluation, navigate,
    fetchProject,
  ]);

  const pageTitle = isEdit ? 'Edit evaluation' : cloneSource ? 'Clone evaluation' : 'Add evaluation';
  const submitLabel = isEdit ? 'Save' : cloneSource ? 'Clone' : 'Add';

  return (
    <div className="dset-form-page">
      <div className="dset-form-page__top-bar">
        <Typography Component="h1" fontSize="fs16" boldness="semibold" className="dset-form-page__top-bar-title">
          {pageTitle}
        </Typography>
        <Button variant="icon" icon={<IconX size={20} />} onClick={navigateBack} aria-label="Close" />
      </div>

      <div className="dset-form-page__body">
        <div className="dset-form-page__body-inner">
          <div className="dset-form-page__header">
            <Typography Component="h2" fontSize="fs20" boldness="semibold">
              Evaluation
            </Typography>
            <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
              {isEdit
                ? 'Update the evaluation configuration. The evaluation name cannot be changed.'
                : cloneSource
                  ? 'Review the cloned settings below. You can modify any field before saving. Test cases from the source evaluation will be copied automatically unless you upload a new file.'
                  : 'Configure your evaluation scope, dataset, judges, and promotion gates. By default, a single validation runs when you start the process.'}
            </Typography>
          </div>

          {cloneSource && (
            <Card>
              <CardContent>
                <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                  Cloning from &quot;{cloneSource.evalName}&quot; — all settings have been pre-filled. Review and save to create the new evaluation.
                </Typography>
              </CardContent>
            </Card>
          )}

          <Card className="dset-form-page__form-card">
            <CardContent>
              <CardBlock type="description" hasSeparator>
                <EvalDetailsSection
                  name={name}
                  description={description}
                  labelItems={labelItems}
                  selectedLabels={selectedLabels}
                  submitted={submitted}
                  isNameReadOnly={isEdit}
                  onNameChange={setName}
                  onDescriptionChange={setDescription}
                  onLabelsChange={setSelectedLabels}
                  onAddLabel={handleAddLabel}
                />
              </CardBlock>
              <CardBlock type="description" hasSeparator>
                <EvalAgentSection
                  agentVersionKey={agentVersionKey}
                  submitted={submitted}
                  onAgentVersionChange={setAgentVersionKey}
                />
              </CardBlock>
              {/* Scheduled runs disabled for this phase - re-enable when needed
              <CardBlock type="description" hasSeparator>
                <EvalScheduleSection
                  scheduleEnabled={scheduleEnabled}
                  scheduleMode={scheduleMode}
                  scheduleCadence={scheduleCadence}
                  scheduleHourUtc={scheduleHourUtc}
                  scheduleMinuteUtc={scheduleMinuteUtc}
                  scheduleCron={scheduleCron}
                  onScheduleEnabledChange={setScheduleEnabled}
                  onScheduleModeChange={setScheduleMode}
                  onScheduleCadenceChange={setScheduleCadence}
                  onScheduleHourUtcChange={setScheduleHourUtc}
                  onScheduleMinuteUtcChange={setScheduleMinuteUtc}
                  onScheduleCronChange={setScheduleCron}
                />
              </CardBlock>
              */}
              <CardBlock type="description">
                <EvalScoringSection
                  strategy={strategy}
                  judgeModel={judgeModel}
                  judgeDimensionIds={judgeDimensionIds}
                  deterministicMetricIds={deterministicMetricIds}
                  isJudgeConfigured={isJudgeConfigured}
                  isDeterministicConfigured={isDeterministicConfigured}
                  datasetColumnMapping={datasetColumnMapping}
                  uploadedFileName={uploadedFileName}
                  submitted={submitted}
                  onStrategyChange={(val) => setStrategy(val as EvalScoringStrategy)}
                  onJudgeConfigSave={handleJudgeConfigSave}
                  onDeterministicConfigSave={handleDeterministicConfigSave}
                />
              </CardBlock>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="dset-form-page__footer">
        <Button
          type="button"
          variant="solid"
          label={submitLabel}
          loading={isSubmitting}
          onClick={handleSubmit}
        />
        <Button type="button" variant="outline" label="Cancel" onClick={navigateBack} isDisabled={isSubmitting} />
      </div>
    </div>
  );
}

export { EvalForm };
