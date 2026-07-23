import type { ReactElement } from "react";

import { InputField } from "@/ui-lib/base-components/form/form-field.input";
import { SelectDropdownField } from "@/ui-lib/base-components/form/form-field.select-dropdown";
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { LABEL_FIELD_SELECT_OPTIONS } from "@/ui-lib/base-components/select-dropdown/select-dropdown.types";
import { DESCRIPTION_MAX_LENGTH } from "./dataset-form.consts";

interface DetailsSectionProps {
  form: AnyReactFormApi;
  isEdit: boolean;
  labelItems: { key: string; value: string; label: string }[];
  onAddLabel: (value: string) => void;
  nameValidatorSync: (opts: { value: string }) => string | undefined;
}

function DetailsSection({
  form,
  isEdit,
  labelItems,
  onAddLabel,
  nameValidatorSync,
}: DetailsSectionProps): ReactElement {

  return (
    <section className="dset-form__section">
      <div className="dset-form__section-header">
        <Typography Component="h2" fontSize="fs14" boldness="semibold" className="dset-form__section-title">
          Details
        </Typography>
        <Typography Component="p" fontSize="fs14" boldness="regular" className="dset-form__section-subtitle">
          Enter the identifying information for this dataset.
        </Typography>
      </div>

      <div className="dset-form__fields">
        <div className="dset-form__field">
          <InputField
            form={form}
            name="name"
            label="Name"
            placeholder="Enter dataset name"
            isReadOnly={isEdit}
            validators={{
              onBlur: nameValidatorSync,
              onSubmit: nameValidatorSync,
              // onBlurAsync: nameValidatorAsync,  // re-enable when /validate exists
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
            tooltip="Add labels to group and filter"
            items={labelItems}
            placeholder="Select or add labels"
            size="fill"
            options={LABEL_FIELD_SELECT_OPTIONS}
            onAddNew={onAddLabel}
          />
        </div>
      </div>
    </section>
  );
}

export { DetailsSection };
export type { DetailsSectionProps };
