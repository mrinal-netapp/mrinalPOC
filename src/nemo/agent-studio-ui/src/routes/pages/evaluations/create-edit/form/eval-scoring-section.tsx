import { useState, type ReactElement, type ReactNode } from 'react';
import { IconBrain, IconCheckbox } from '@tabler/icons-react';

import { useAppSelector } from '@/store';
import { projectContextSelector } from '@/store/selectors/project-context.selector';
import type { EvalScoringStrategy, EvalDatasetColumnMapping } from '@/routes/pages/evaluations/api/eval.types';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import { Button } from '@/ui-lib/base-components/button/button';
import { Card } from '@/ui-lib/base-components/card/card';
import { CardHeader } from '@/ui-lib/base-components/card/card.header';
import { CardContent } from '@/ui-lib/base-components/card/card.content';
import { CardBlock, CardBlockLabel } from '@/ui-lib/base-components/card/card.block';
import { RadioGroup } from '@/ui-lib/base-components/radio-button/radio-button';
import { SelectorWrapper } from '@/ui-lib/base-components/selector-wrapper/selector-wrapper';
import { EvalPropertyStatus } from '@/components/evaluations/property-status/eval-property-status';
import { JudgeConfigDialog, JUDGE_DIMENSIONS } from '@/components/evaluations/configure-dialogs/judge-config-dialog';
import { DeterministicConfigDialog, METRIC_CATALOG } from '@/components/evaluations/configure-dialogs/deterministic-config-dialog';
import type { DeterministicConfigSavePayload } from '@/components/evaluations/configure-dialogs/deterministic-config-dialog';
import { useListProjectModelsQuery } from '@/routes/pages/agents/api/agents-config-api.slice';
import { STRATEGY_OPTIONS } from './eval-form.consts';

import './eval-scoring-section.scss';

type ConfigureCardRow = {
  label: string;
  value: ReactNode;
};

type ConfigureCardProps = {
  icon: ReactElement;
  title: string;
  rows: ConfigureCardRow[];
  hasError?: boolean;
  errorMessage?: string;
  onConfigure: () => void;
};

function ConfigureCard({ icon, title, rows, hasError, errorMessage, onConfigure }: ConfigureCardProps): ReactElement {
  return (
    <div className={`eval-configure-card-wrapper${hasError ? ' eval-configure-card-wrapper--error' : ''}`}>
      <Card className="eval-configure-card">
        <CardHeader
          icon={icon}
          title={title}
          hasSeparator
          actions={[
            <Button
              key="configure"
              type="button"
              variant="outline"
              size="medium"
              label="Configure"
              onClick={onConfigure}
            />,
          ]}
        />
        <CardContent>
          {rows.map((row, idx) => (
            <CardBlock key={row.label} type="key-value" hasSeparator={idx < rows.length - 1}>
              <CardBlockLabel>{row.label}</CardBlockLabel>
              {typeof row.value === 'string'
                ? (
                  <Typography Component="span" fontSize="fs14" boldness="regular">
                    {row.value}
                  </Typography>
                )
                : row.value}
            </CardBlock>
          ))}
        </CardContent>
      </Card>
      {hasError && errorMessage && (
        <Typography Component="p" fontSize="fs13" boldness="regular" color="var(--notification-error)" className="eval-configure-card-error">
          {errorMessage}
        </Typography>
      )}
    </div>
  );
}

type EvalScoringSectionProps = {
  strategy: EvalScoringStrategy;
  judgeModel: string;
  judgeDimensionIds: string[];
  deterministicMetricIds: string[];
  isJudgeConfigured: boolean;
  isDeterministicConfigured: boolean;
  datasetColumnMapping: EvalDatasetColumnMapping;
  uploadedFileName: string;
  submitted: boolean;
  onStrategyChange: (val: string) => void;
  onJudgeConfigSave: (model: string, dimensionIds: string[]) => void;
  onDeterministicConfigSave: (payload: DeterministicConfigSavePayload) => void;
};

function EvalScoringSection({
  strategy,
  judgeModel,
  judgeDimensionIds,
  deterministicMetricIds,
  isJudgeConfigured,
  isDeterministicConfigured,
  datasetColumnMapping,
  uploadedFileName,
  submitted,
  onStrategyChange,
  onJudgeConfigSave,
  onDeterministicConfigSave,
}: EvalScoringSectionProps): ReactElement {
  const [judgeDialogOpen, setJudgeDialogOpen] = useState(false);
  const [deterministicDialogOpen, setDeterministicDialogOpen] = useState(false);
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data: models = [] } = useListProjectModelsQuery(
    { projectId, modelType: 'llm' },
    { skip: !projectId },
  );

  const isJudgeEnabled = strategy === 'llm_judge' || strategy === 'both';
  const judgeCardError = submitted && isJudgeEnabled && (!isJudgeConfigured || !judgeModel);
  const deterministicCardError = submitted && !isDeterministicConfigured;
  const judgeModelDisplayName = models.find((model) => model.id === judgeModel)?.displayName
    ?? models.find((model) => model.id === judgeModel)?.name
    ?? judgeModel;

  const judgeDimensionLabels = judgeDimensionIds
    .map((id) => JUDGE_DIMENSIONS.find((d) => d.id === id)?.title)
    .filter(Boolean)
    .join(', ');

  const deterministicMetricLabels = deterministicMetricIds
    .map((id) => METRIC_CATALOG.find((m) => m.id === id)?.title)
    .filter(Boolean)
    .join(', ');

  return (
    <section className="dset-form__section">
      <div className="dset-form__section-header">
        <Typography Component="h2" fontSize="fs14" boldness="semibold" className="dset-form__section-title">
          Evaluation strategy
        </Typography>
        <Typography Component="p" fontSize="fs14" boldness="regular" className="dset-form__section-subtitle">
          Select an evaluation strategy to maintain a structured audit trail for this run.
        </Typography>
      </div>
      <div className="dset-form__fields">
        <RadioGroup
          ariaLabel="Strategy"
          value={strategy}
          onValueChange={(val) => onStrategyChange(val as string)}
        >
          {STRATEGY_OPTIONS.map((opt) => (
            <SelectorWrapper
              key={opt.value}
              selectorType="radioButton"
              selectorProps={{ value: opt.value }}
              label={opt.title}
              labelBoldness="semibold"
              description={opt.description}
            />
          ))}
        </RadioGroup>

        <div className="eval-scoring-cards">
          {/* Deterministic metrics — required; must be configured before submitting */}
          <ConfigureCard
            icon={<IconCheckbox size={24} color={deterministicCardError ? 'var(--notification-error)' : 'var(--text-button-primary)'} />}
            title="Deterministic metrics"
            hasError={deterministicCardError}
            errorMessage="Deterministic metrics must be configured before creating the evaluation."
            rows={[
              {
                label: 'Metrics',
                value: isDeterministicConfigured
                  ? (deterministicMetricLabels || '—')
                  : (
                    <Typography Component="span" fontSize="fs14" boldness="regular" color={deterministicCardError ? 'var(--notification-error)' : 'var(--text-secondary)'}>
                      {deterministicCardError ? 'Required — click Configure' : 'Not configured'}
                    </Typography>
                  ),
              },
              {
                label: 'Test cases',
                value: isDeterministicConfigured
                  ? (
                    <span className="eval-scoring-test-cases">
                      <EvalPropertyStatus label="Enabled" />
                      {uploadedFileName && (
                        <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                          {uploadedFileName}
                        </Typography>
                      )}
                    </span>
                  )
                  : (
                    <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                      —
                    </Typography>
                  ),
              },
            ]}
            onConfigure={() => setDeterministicDialogOpen(true)}
          />

          {isJudgeEnabled && (
            <ConfigureCard
              icon={<IconBrain size={24} color={judgeCardError ? 'var(--notification-error)' : 'var(--text-button-primary)'} />}
              title="AI judge"
              hasError={judgeCardError}
              errorMessage="AI judge must be configured before creating the evaluation."
              rows={[
                {
                  label: 'Model',
                  value: isJudgeConfigured && judgeModel
                    ? judgeModelDisplayName
                    : (
                      <Typography Component="span" fontSize="fs14" boldness="regular" color={judgeCardError ? 'var(--notification-error)' : 'var(--text-secondary)'}>
                        {judgeCardError ? 'Required — click Configure' : 'Not configured'}
                      </Typography>
                    ),
                },
                { label: 'Dimensions', value: isJudgeConfigured ? (judgeDimensionLabels || '—') : '—' },
              ]}
              onConfigure={() => setJudgeDialogOpen(true)}
            />
          )}
        </div>
      </div>

      <JudgeConfigDialog
        open={judgeDialogOpen}
        onOpenChange={setJudgeDialogOpen}
        selectedModel={judgeModel}
        selectedDimensionIds={judgeDimensionIds}
        onSave={(model, dimensionIds) => {
          onJudgeConfigSave(model, dimensionIds);
          setJudgeDialogOpen(false);
        }}
      />

      <DeterministicConfigDialog
        open={deterministicDialogOpen}
        onOpenChange={setDeterministicDialogOpen}
        selectedMetricIds={deterministicMetricIds}
        datasetColumnMapping={datasetColumnMapping}
        uploadedFileName={uploadedFileName}
        onSave={(payload) => {
          onDeterministicConfigSave(payload);
          setDeterministicDialogOpen(false);
        }}
      />
    </section>
  );
}

export { EvalScoringSection };
