import type { ReactElement } from "react";

import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { SelectDropdownField } from "@/ui-lib/base-components/form/form-field.select-dropdown";
import { Typography } from "@/ui-lib/base-components/typography/typography";

import { AGENT_CONFIGURATION_OPTIONS } from "./agent-form.consts";

interface SetupSectionProps {
  form: AnyReactFormApi;
}

function SetupSection({ form }: SetupSectionProps): ReactElement {
  return (
    <section className="agent-form__section">
      <div className="agent-form__section-header">
        <Typography
          Component="h2"
          fontSize="fs16"
          boldness="semibold"
          className="agent-form__section-title"
        >
          Setup
        </Typography>
      </div>

      <div className="agent-form__section-body">
        <div className="agent-form__field">
          <SelectDropdownField
            form={form}
            name="configuration"
            label="Configuration"
            items={AGENT_CONFIGURATION_OPTIONS}
            placeholder="Select configuration"
            size="fill"
          />
        </div>
      </div>
    </section>
  );
}

export { SetupSection };
export type { SetupSectionProps };
