import type { ReactElement } from "react";

import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { InputField } from "@/ui-lib/base-components/form/form-field.input";
import { ProjectFormSection } from "./project-form-section";
import {
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_FORM_STRINGS,
} from "./project-form.consts";

interface ProjectDetailsSectionProps {
  form: AnyReactFormApi;
}

function ProjectDetailsSection({ form }: ProjectDetailsSectionProps): ReactElement {
  return (
    <ProjectFormSection title={PROJECT_FORM_STRINGS.DETAILS_SECTION_TITLE} defaultExpanded>
      <div className="project-details-section__fields">
        <InputField
          form={form}
          name="name"
          label={PROJECT_FORM_STRINGS.NAME_LABEL}
          placeholder={PROJECT_FORM_STRINGS.NAME_PLACEHOLDER}
          validators={{
            onBlur: ({ value }: { value: string }) =>
              value.trim() ? undefined : PROJECT_FORM_STRINGS.NAME_REQUIRED,
          }}
        />
        <InputField
          form={form}
          name="description"
          label={PROJECT_FORM_STRINGS.DESCRIPTION_LABEL}
          placeholder={PROJECT_FORM_STRINGS.DESCRIPTION_PLACEHOLDER}
          tooltip={PROJECT_FORM_STRINGS.DESCRIPTION_TOOLTIP}
          isOptional
          max={PROJECT_DESCRIPTION_MAX_LENGTH}
          isShowCount
        />
      </div>
    </ProjectFormSection>
  );
}

export { ProjectDetailsSection };
