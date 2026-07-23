import { useCallback, useMemo, useState, type ReactElement } from 'react';

import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogFooter,
  DialogTitle,
} from '@/ui-lib/base-components/dialog/dialog';
import { Button } from '@/ui-lib/base-components/button/button';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import { SelectDropdown } from '@/ui-lib/base-components/select-dropdown/select-dropdown';
import { useAppSelector } from '@/store';
import { projectContextSelector } from '@/store/selectors/project-context.selector';
import { useListProjectModelsQuery } from '@/routes/pages/agents/api/agents-config-api.slice';

import './configure-dialog.scss';

type JudgeDimension = {
  id: string;
  title: string;
  description: string;
};

const JUDGE_DIMENSIONS: JudgeDimension[] = [
  { id: 'helpfulness', title: 'Helpfulness', description: 'How useful the response is to the user\'s goal.' },
  { id: 'correctness', title: 'Correctness', description: 'Factual and logical accuracy relative to the task and any reference.' },
  { id: 'completeness', title: 'Completeness', description: 'Whether the response fully addresses all parts of the query.' },
  { id: 'coherence', title: 'Coherence', description: 'Structure, clarity, and readability.' },
  { id: 'following_instructions', title: 'Following instructions', description: 'Adherence to system/developer/user constraints.' },
  { id: 'professional_style_tone', title: 'Professional style and tone', description: 'Appropriate register for the audience and brand.' },
  { id: 'faithfulness_groundedness', title: 'Faithfulness and groundedness', description: 'Claims must be supported by provided context; penalize hallucination.' },
  { id: 'safety_harmlessness', title: 'Safety and harmlessness', description: 'Avoid harmful, abusive, or policy-violating content.' },
  { id: 'refusal_quality', title: 'Refusal quality', description: 'Refuse when appropriate; avoid false refusals on benign tasks.' },
];

type JudgeConfigDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedModel: string;
  selectedDimensionIds: string[];
  onSave: (model: string, dimensionIds: string[]) => void;
};

function JudgeConfigDialog({
  open,
  onOpenChange,
  selectedModel,
  selectedDimensionIds,
  onSave,
}: JudgeConfigDialogProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg">
      {open && (
        <JudgeConfigDialogContent
          selectedModel={selectedModel}
          selectedDimensionIds={selectedDimensionIds}
          onSave={onSave}
          onOpenChange={onOpenChange}
        />
      )}
    </Dialog>
  );
}

type JudgeConfigDialogContentProps = Pick<
  JudgeConfigDialogProps,
  'selectedModel' | 'selectedDimensionIds' | 'onSave' | 'onOpenChange'
>;

function JudgeConfigDialogContent({
  selectedModel,
  selectedDimensionIds,
  onSave,
  onOpenChange,
}: JudgeConfigDialogContentProps): ReactElement {
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data: models = [], isLoading: isModelsLoading } = useListProjectModelsQuery(
    { projectId, modelType: 'llm' },
    { skip: !projectId },
  );
  const [draftModel, setDraftModel] = useState(selectedModel);
  const [draftDimensionIds, setDraftDimensionIds] = useState<string[]>(selectedDimensionIds);

  const modelItems = useMemo(
    () => models.map((model) => {
      const name = model.displayName ?? model.name ?? model.id;

      return { key: model.id, value: model.id, label: name };
    }),
    [models],
  );

  const toggleDimension = useCallback((id: string) => {
    setDraftDimensionIds((prev) =>
      prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id],
    );
  }, []);

  const handleSave = useCallback(() => {
    onSave(draftModel, draftDimensionIds);
    onOpenChange(false);
  }, [draftModel, draftDimensionIds, onSave, onOpenChange]);

  return (
    <DialogPopup className="configure-dialog__popup">
      <DialogHeader>
        <DialogTitle>Configure AI judge</DialogTitle>
      </DialogHeader>

      <div className="configure-dialog__body">
        <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
          Set your evaluation scope by choosing criteria to include. Every score includes a rationale.
        </Typography>

        <div className="configure-dialog__field">
          <Typography Component="label" fontSize="fs14" boldness="semibold">
            Model
          </Typography>
          <SelectDropdown
            items={modelItems}
            value={draftModel}
            onValueChange={(val) => setDraftModel(val as string)}
            placeholder="Select model"
            size="fill"
            isLoading={isModelsLoading}
            emptyMessage="No models available"
          />
        </div>

        <div className="configure-dialog__table">
          <div className="configure-dialog__table-header">
            <span className="configure-dialog__table-cell configure-dialog__table-cell--check">
              <input
                type="checkbox"
                checked={draftDimensionIds.length === JUDGE_DIMENSIONS.length}
                onChange={() => {
                  if (draftDimensionIds.length === JUDGE_DIMENSIONS.length) {
                    setDraftDimensionIds([]);
                  } else {
                    setDraftDimensionIds(JUDGE_DIMENSIONS.map((d) => d.id));
                  }
                }}
                aria-label="Select all dimensions"
              />
            </span>
            <Typography Component="span" fontSize="fs12" boldness="semibold" color="var(--text-secondary)" className="configure-dialog__table-cell">
              Dimension
            </Typography>
            <Typography Component="span" fontSize="fs12" boldness="semibold" color="var(--text-secondary)" className="configure-dialog__table-cell configure-dialog__table-cell--desc">
              Description
            </Typography>
            <Typography Component="span" fontSize="fs12" boldness="semibold" color="var(--text-secondary)" className="configure-dialog__table-cell">
              Output
            </Typography>
          </div>
          {JUDGE_DIMENSIONS.map((dim) => (
            <div key={dim.id} className="configure-dialog__table-row">
              <span className="configure-dialog__table-cell configure-dialog__table-cell--check">
                <input
                  type="checkbox"
                  checked={draftDimensionIds.includes(dim.id)}
                  onChange={() => toggleDimension(dim.id)}
                  aria-label={`Select ${dim.title}`}
                />
              </span>
              <Typography Component="span" fontSize="fs14" boldness="regular" className="configure-dialog__table-cell">
                {dim.title}
              </Typography>
              <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)" className="configure-dialog__table-cell configure-dialog__table-cell--desc">
                {dim.description}
              </Typography>
              <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)" className="configure-dialog__table-cell">
                Score, rationale
              </Typography>
            </div>
          ))}
        </div>
      </div>

      <DialogFooter>
        <Button type="button" variant="solid" label="Save" onClick={handleSave} />
        <Button type="button" variant="outline" label="Cancel" onClick={() => onOpenChange(false)} />
      </DialogFooter>
    </DialogPopup>
  );
}

export { JudgeConfigDialog, JUDGE_DIMENSIONS };
