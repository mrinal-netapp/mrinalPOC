import type { ReactElement } from 'react';

import type { AnyReactFormApi } from '@/ui-lib/base-components/form/form.types';
import { InputField } from '@/ui-lib/base-components/form/form-field.input';
import { SelectDropdownField } from '@/ui-lib/base-components/form/form-field.select-dropdown';
import { ToggleField } from '@/ui-lib/base-components/form';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import { LABEL_FIELD_SELECT_OPTIONS } from '@/ui-lib/base-components/select-dropdown/select-dropdown.types';
import { DESCRIPTION_MAX_LENGTH } from './kb-form.consts';

interface KBDetailsSectionProps {
  form: AnyReactFormApi;
  isEdit: boolean;
  labelItems: { key: string; value: string; label: string }[];
  onAddLabel: (value: string) => void;
  nameValidatorSync: (opts: { value: string }) => string | undefined;
  nameValidatorAsync: (opts: { value: string }) => Promise<string | undefined>;
}

function KBDetailsSection({
  form,
  isEdit,
  labelItems,
  onAddLabel,
  nameValidatorSync,
  nameValidatorAsync,
}: KBDetailsSectionProps): ReactElement {
  return (
    <section className="dset-form__section">
      <div className="dset-form__section-header">
        <Typography Component="h2" fontSize="fs14" boldness="semibold" className="dset-form__section-title">
          Details
        </Typography>
        <Typography Component="p" fontSize="fs14" boldness="regular" className="dset-form__section-subtitle">
          Provide identifying information for this knowledge base.
        </Typography>
      </div>

      <div className="dset-form__fields">
        <div className="dset-form__field">
          <InputField
            form={form}
            name="name"
            label="Name"
            placeholder="Enter knowledge base name"
            isReadOnly={isEdit}
            validators={{
              onBlur: nameValidatorSync,
              onBlurAsync: nameValidatorAsync,
            }}
          />
        </div>

        <div className="dset-form__field">
          <InputField
            form={form}
            name="description"
            label="Description"
            isOptional
            placeholder="Enter description"
            maxLength={DESCRIPTION_MAX_LENGTH}
          />
        </div>

        <div className="dset-form__field">
          <SelectDropdownField
            form={form}
            name="labels"
            label="Labels"
            className="form-field--labels"
            isOptional
            tooltip="Assign labels to categorize this knowledge base"
            items={labelItems}
            placeholder="Select or add labels"
            size="fill"
            options={LABEL_FIELD_SELECT_OPTIONS}
            onAddNew={onAddLabel}
          />
        </div>

        <div className="dset-form__field">
          <ToggleField
            form={form}
            name="use_pipeline"
            label="Use same details for an execution of a pipeline"
            isDisabled
          />
        </div>
      </div>
    </section>
  );
}

export { KBDetailsSection };
export type { KBDetailsSectionProps };
