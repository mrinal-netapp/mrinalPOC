import type { ReactElement } from 'react';

import { Input } from '@/ui-lib/base-components/input/input';
import { SelectDropdown } from '@/ui-lib/base-components/select-dropdown/select-dropdown';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import { FormFieldErrorBlock } from '@/ui-lib/base-components/form/form-field.message';
import { DESCRIPTION_MAX_LENGTH, EVAL_NAME_PATTERN } from './eval-form.consts';

type LabelItem = { key: string; value: string; label: string };

type EvalDetailsSectionProps = {
  name: string;
  description: string;
  labelItems: LabelItem[];
  selectedLabels: string[];
  submitted: boolean;
  /** When true the name field is read-only (edit mode — eval names cannot change). */
  isNameReadOnly?: boolean;
  onNameChange: (name: string) => void;
  onDescriptionChange: (description: string) => void;
  onLabelsChange: (labels: string[]) => void;
  onAddLabel: (label: string) => void;
};

function EvalDetailsSection({
  name,
  description,
  labelItems,
  selectedLabels,
  submitted,
  isNameReadOnly = false,
  onNameChange,
  onDescriptionChange,
  onLabelsChange,
  onAddLabel,
}: EvalDetailsSectionProps): ReactElement {
  const trimmedName = name.trim();
  const nameError = submitted && !trimmedName
    ? 'Name is required.'
    : submitted && trimmedName && !EVAL_NAME_PATTERN.test(trimmedName)
      ? 'Name may only contain letters, numbers, spaces, hyphens, and underscores.'
      : undefined;

  return (
    <section className="dset-form__section">
      <div className="dset-form__section-header">
        <Typography Component="h2" fontSize="fs14" boldness="semibold" className="dset-form__section-title">
          Details
        </Typography>
        <Typography Component="p" fontSize="fs14" boldness="regular" className="dset-form__section-subtitle">
          Provide the identifying information for this evaluation run.
        </Typography>
      </div>
      <div className="dset-form__fields">
        <div className="dset-form__field">
          <Input
            label="Name"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="e.g. RAG Validation"
            isError={!!nameError}
            readOnly={isNameReadOnly}
          />
          {nameError && <FormFieldErrorBlock message={nameError} />}
        </div>
        <div className="dset-form__field">
          <Input
            label="Description"
            isOptional
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder="Help reviewers understand the purpose of this run."
            maxLength={DESCRIPTION_MAX_LENGTH}
          />
        </div>
        <div className="dset-form__field">
          <SelectDropdown
            label="Labels"
            items={labelItems}
            value={selectedLabels}
            onValueChange={(val) => onLabelsChange(val as string[])}
            placeholder="Add label..."
            size="fill"
            emptyMessage=""
            options={{
              isOptional: true,
              isMultiSelect: true,
              isChipDisplay: true,
              isClearable: true,
              isSearchable: true,
              canAddNew: true,
            }}
            onAddNew={onAddLabel}
          />
        </div>
      </div>
    </section>
  );
}

export { EvalDetailsSection };
