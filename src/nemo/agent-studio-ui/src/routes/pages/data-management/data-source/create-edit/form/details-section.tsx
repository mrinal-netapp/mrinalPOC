import type { ReactElement } from "react";

import { InputField } from "@/ui-lib/base-components/form/form-field.input";
import { SelectDropdownField } from "@/ui-lib/base-components/form/form-field.select-dropdown";
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { LABEL_FIELD_SELECT_OPTIONS } from "@/ui-lib/base-components/select-dropdown/select-dropdown.types";
import { DESCRIPTION_MAX_LENGTH } from "./data-source-form.consts";

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
    <section className="ds-form__section">
      <div className="ds-form__section-header">
        <Typography Component="h2" fontSize="fs14" boldness="semibold" className="ds-form__section-title">
          Details
        </Typography>
        <Typography Component="p" fontSize="fs14" boldness="regular" className="ds-form__section-subtitle">
          Provide the identifying information for this data source.
        </Typography>
      </div>

      <div className="ds-form__fields">
        <div className="ds-form__field">
          <InputField
            form={form}
            name="name"
            label="Name"
            placeholder="Enter data source name"
            isReadOnly={isEdit}
            validators={{
              onBlur: nameValidatorSync,
              // Validate on submit too so clicking "Register" still enforces the
              // required/length rules. Name uniqueness is enforced by the
              // backend (409 on create), so no async pre-check is needed.
              onSubmit: nameValidatorSync,
            }}
          />
        </div>

        <div className="ds-form__field">
          <InputField
            form={form}
            name="description"
            label="Description"
            isOptional
            placeholder="Enter description"
            maxLength={DESCRIPTION_MAX_LENGTH}
          />
        </div>

        <div className="ds-form__field">
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
